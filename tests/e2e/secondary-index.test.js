/**
 * @file E2E secondary index tests
 *
 * Covers the schema-declared $indexes vocabulary, the QueryPlanner that
 * consults it, the middleware that keeps the underlying SortedIndex in sync
 * with add/set/del, and the bounded-hydration guarantee for .where queries
 * (and .where + .near combinations).
 *
 * Coverage:
 *   - $indexes declared on a schema is honored on lookup
 *   - compound index used for matching prefix returns the right candidates
 *   - non-prefix .where falls back to scan (no false bounded result)
 *   - insert / set / delete keep indexes consistent
 *   - schema declaring an index over an undeclared field throws at startup
 *   - indexes survive process restart (snapshot persistence)
 *   - .where + .near hydrates ONLY the candidate set, not the whole collection
 *
 * @implements engine portion of UC-X1 (.where + .near in a single round-trip)
 */
import { jest } from '@jest/globals';
import { createDB } from '../../client/index.js';
import { SecondaryIndexManager, SortedIndex, compoundKey } from '../../engine/secondary-index.js';
import { QueryPlanner } from '../../engine/query-planner.js';
import { compileFilter } from '../../engine/filter-compiler.js';
import fs from 'fs/promises';

const DIR = './test-data-secondary';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return createDB({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('SortedIndex (unit-shaped, but driven via the manager)', () => {
  test('insert + lookup', () => {
    const idx = new SortedIndex();
    idx.insert(compoundKey(['fact']), 'A');
    idx.insert(compoundKey(['fact']), 'B');
    idx.insert(compoundKey(['pref']), 'C');
    expect(idx.lookup(compoundKey(['fact']))).toEqual(['A', 'B']);
    expect(idx.lookup(compoundKey(['pref']))).toEqual(['C']);
    expect(idx.lookup(compoundKey(['unknown']))).toEqual([]);
  });

  test('remove cleans up empty entries', () => {
    const idx = new SortedIndex();
    idx.insert('K', 'A');
    idx.remove('K', 'A');
    expect(idx.entries()).toHaveLength(0);
  });

  test('serialize / deserialize roundtrip', () => {
    const idx = new SortedIndex();
    idx.insert('a', '1');
    idx.insert('b', '2');
    idx.insert('a', '3');
    const ser = idx.serialize();
    const back = SortedIndex.deserialize(ser);
    expect(back.lookup('a')).toEqual(['1', '3']);
    expect(back.lookup('b')).toEqual(['2']);
  });

  // entries() must run its loop when keys are present (distinct from the
  // remove() test hitting an empty entries() list).
  test('entries() enumerates compound keys with cloned id arrays', () => {
    const idx = new SortedIndex();
    idx.insert('ka', 'a1');
    idx.insert('kb', 'b1');
    const list = [...idx.entries()].sort((a, b) => a.key.localeCompare(b.key));
    expect(list).toEqual([
      { key: 'ka', ids: ['a1'] },
      { key: 'kb', ids: ['b1'] },
    ]);
    const row = idx.entries()[0];
    row.ids.push('evil');
    expect(idx.lookup(row.key)).not.toContain('evil');
  });

  test('insert is idempotent when the same $ID is indexed twice under the same key', () => {
    const idx = new SortedIndex();
    const k = compoundKey(['fact']);
    idx.insert(k, 'DOC_1');
    idx.insert(k, 'DOC_1');
    expect(idx.lookup(k)).toEqual(['DOC_1']);
  });

  test('remove skips splice when the id is absent (key present, id missing)', () => {
    const idx = new SortedIndex();
    idx.insert('K', 'only');
    idx.remove('K', 'ghost');
    expect(idx.lookup('K')).toEqual(['only']);
  });

  test('deserialize fills empty key/id tables when snapshot omits arrays', () => {
    const idx = SortedIndex.deserialize({});
    expect(idx.entries()).toEqual([]);
  });
});

describe('SecondaryIndexManager (exported, in-process)', () => {
  test('insert/remove/update on an undeclared collection are no-ops', () => {
    const mgr = new SecondaryIndexManager();
    mgr.insert('missingCol', { $ID: 'x', a: 1 });
    mgr.remove('missingCol', { $ID: 'x', a: 1 });
    mgr.update('missingCol', { $ID: 'x', a: 1 }, { $ID: 'x', a: 2 });
    expect([...mgr.collections()]).toHaveLength(0);
  });

  test('update skips remove/insert when compound key fields are unchanged', () => {
    const mgr = new SecondaryIndexManager();
    mgr.declare('row', ['k']);
    mgr.insert('row', { $ID: 'r1', k: 'same' });
    mgr.update(
      'row',
      { $ID: 'r1', k: 'same' },
      { $ID: 'r1', k: 'same', note: 'only non-indexed fields differ' }
    );
    const serialized = mgr.serialize().row[0].data;
    expect(serialized.keys).toEqual([compoundKey(['same'])]);
    expect(serialized.ids[0]).toEqual(['r1']);
  });

  test('update maps indexed fields with ?? when oldDoc omits a column', () => {
    const mgr = new SecondaryIndexManager();
    mgr.declare('pair', ['a', 'b']);
    mgr.insert('pair', { $ID: 'px', a: 1, b: 2 });
    mgr.update(
      'pair',
      { $ID: 'px', a: 1 },
      { $ID: 'px', a: 1, b: 9 }
    );
    const still = mgr.candidatesFor('pair', { a: 1, b: 9 });
    expect(still && still.ids).toContain('px');
  });

  test('update maps indexed fields with ?? when newDoc omits a column', () => {
    const mgr = new SecondaryIndexManager();
    mgr.declare('pair2', ['a', 'b']);
    mgr.insert('pair2', { $ID: 'py', a: 1, b: 2 });
    mgr.update(
      'pair2',
      { $ID: 'py', a: 1, b: 2 },
      { $ID: 'py', a: 1 }
    );
    expect(mgr.candidatesFor('pair2', { a: 1, b: null }).ids).toContain('py');
  });

  test('candidatesFor picks the tighter id set when prefix length ties across specs', () => {
    const mgr = new SecondaryIndexManager();
    mgr.declare('dual', ['a']);
    mgr.declare('dual', ['b']);
    mgr.insert('dual', { $ID: 'n1', a: 'X', b: 'Y' });
    mgr.insert('dual', { $ID: 'n2', a: 'X', b: 'Z' });
    mgr.insert('dual', { $ID: 'n3', a: 'W', b: 'Y' });
    mgr.insert('dual', { $ID: 'n4', a: 'X', b: 'Z' });
    const plan = mgr.candidatesFor('dual', { a: 'X', b: 'Y' });
    expect(plan).not.toBeNull();
    expect(plan.ids.sort()).toEqual(['n1', 'n3'].sort());
    expect(plan.covered).toEqual(['b']);
  });

  test('candidatesFor keeps earlier best when tied plans have the same ids length', () => {
    const mgr = new SecondaryIndexManager();
    mgr.declare('tie', ['alpha']);
    mgr.declare('tie', ['beta']);
    mgr.insert('tie', { $ID: 'd1', alpha: 'A', beta: 'B' });
    mgr.insert('tie', { $ID: 'd2', alpha: 'A', beta: 'C' });
    mgr.insert('tie', { $ID: 'd3', alpha: 'Z', beta: 'B' });
    const plan = mgr.candidatesFor('tie', { alpha: 'A', beta: 'B' });
    expect(plan).not.toBeNull();
    expect(plan.ids.sort()).toEqual(['d1', 'd2'].sort());
    expect(plan.covered).toEqual(['alpha']);
  });

  test('load(null) clears in-memory specs after populate', () => {
    const mgr = new SecondaryIndexManager();
    mgr.declare('z', ['f']);
    mgr.insert('z', { $ID: 'z1', f: 1 });
    mgr.load(null);
    expect(mgr.candidatesFor('z', { f: 1 })).toBeNull();
  });
});

describe('QueryPlanner (direct)', () => {
  test('function filter skips index planning; residual is the predicate', () => {
    const planner = new QueryPlanner({});
    const pred = doc => doc.type === 'fact';
    const plan = planner.planWhere('collection', pred);
    expect(plan.useIndex).toBe(false);
    expect(plan.candidateIds).toBeNull();
    expect(plan.residualFilter).toBe(pred);
  });

  test('non-null non-function non-object filter throws', () => {
    const planner = new QueryPlanner({});
    expect(() => planner.planWhere('collection', true)).toThrow(/unsupported filter type boolean/);
  });

  test('when registry has no secondary index manager, filter compiles to residual predicate', () => {
    const planner = new QueryPlanner({ secondaryIndexManager: () => undefined });
    const plan = planner.planWhere('memoryArtifact', { type: 'fact' });
    expect(plan.useIndex).toBe(false);
    expect(plan.candidateIds).toBeNull();
    expect(typeof plan.residualFilter).toBe('function');
    expect(plan.residualFilter({ type: 'fact' })).toBe(true);
    expect(plan.residualFilter({ type: 'other' })).toBe(false);
  });

  test('compileFilter(null/undefined) yields identity; object predicate rejects null doc', () => {
    expect(compileFilter(null)({})).toBe(true);
    expect(compileFilter(undefined)(null)).toBe(true);
    expect(compileFilter({ a: 1 })(null)).toBe(false);
  });

  test('compileFilter forwards function filters; literals treat array/object by reference', () => {
    const passthrough = doc => doc.ok === 1;
    expect(compileFilter(passthrough)).toBe(passthrough);
    const arr = [];
    expect(compileFilter({ list: arr })({ list: arr })).toBe(true);
    const blob = {};
    expect(compileFilter({ blob })({ blob })).toBe(true);
  });
});

describe('Schema $indexes declaration', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('declared $indexes is consulted by .where', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      content: { type: String, required: false },
      $indexes: [['type']]
    });
    await db.add.memoryArtifact({ type: 'fact', content: 'A' });
    await db.add.memoryArtifact({ type: 'fact', content: 'B' });
    await db.add.memoryArtifact({ type: 'preference', content: 'C' });
    const facts = await db.get.memoryArtifactS.where({ type: 'fact' });
    expect(facts).toHaveLength(2);
    for (const f of facts) expect(f.type).toBe('fact');
  });

  /**
   * Function filters cannot participate in compound-index planning — the
   * planner emits a scan + residual predicate (same path QueryPlanner exposes
   * to unit tests directly).
   */
  test('.where(Function) skips index planning still filters correctly', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      $indexes: [['type']]
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'pref' });
    const facts = await db.get.memoryArtifactS.where(doc => doc.type === 'fact').toArray();
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('fact');
  });

  test('.where rejects non-object filter at execution', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      $indexes: [['type']]
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await expect(db.get.memoryArtifactS.where(true).toArray()).rejects.toThrow(/unsupported filter type boolean/);
  });

  test('compound prefix index handles partial filter', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      session: { type: String, required: false },
      $indexes: [['session', 'type']]
    });
    await db.add.memoryArtifact({ type: 'fact', session: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', session: 'S2' });
    await db.add.memoryArtifact({ type: 'pref', session: 'S1' });
    const inS1 = await db.get.memoryArtifactS.where({ session: 'S1' });
    expect(inS1).toHaveLength(2);
    for (const r of inS1) expect(r.session).toBe('S1');
  });

  test('index-bounded equality + extra filter field applies residual after hydrate', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:   { type: String, required: true },
      status: { type: String, required: false },
      $indexes: [['type']]
    });
    await db.add.memoryArtifact({ type: 'doc', status: 'live' });
    await db.add.memoryArtifact({ type: 'doc', status: 'archived' });
    await db.add.memoryArtifact({ type: 'note', status: 'live' });
    // Index narrows by `type`; `status` is a residual predicate (handled in executeWherePlan line 21-23)
    const rows = await db.get.memoryArtifactS.where({
      type: 'doc',
      status: 'live'
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('live');
  });

  test('range operator on an indexed equality field skips index prefix (scan + residual)', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      $indexes: [['type']]
    });
    await db.add.memoryArtifact({ type: 'apple' });
    await db.add.memoryArtifact({ type: 'zebra' });
    const hi = await db.get.memoryArtifactS.where({ type: { $gte: 'm' } }).toArray();
    expect(hi.map(r => r.type).sort()).toEqual(['zebra']);
  });

  test('equality on indexed Object field distinguishes empty-object literal via isOperatorClause', async () => {
    db = await freshDB();
    db.schema('slotDoc', {
      bucket: { type: Object, required: true },
      name: { type: String, required: true },
      $indexes: [['bucket']]
    });
    const empty = {};
    await db.add.slotDoc({ bucket: empty, name: 'one' });
    await db.add.slotDoc({ bucket: { x: 1 }, name: 'two' });
    const rows = await db.get.slotDocS.where({ bucket: empty }).toArray();
    expect(rows.map(r => r.name).sort()).toEqual(['one']);
  });

  test('non-prefix .where falls back to scan and still returns correct results', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      session: { type: String, required: false },
      $indexes: [['session', 'type']]  // session-first; filter on type alone is not a prefix
    });
    await db.add.memoryArtifact({ type: 'fact', session: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', session: 'S2' });
    await db.add.memoryArtifact({ type: 'pref', session: 'S1' });
    const facts = await db.get.memoryArtifactS.where({ type: 'fact' });
    expect(facts).toHaveLength(2);
    for (const f of facts) expect(f.type).toBe('fact');
  });

  test('insert/update/delete keep indexes consistent', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      $indexes: [['type']]
    });
    const a = await db.add.memoryArtifact({ type: 'fact' });
    const b = await db.add.memoryArtifact({ type: 'fact' });

    // Update one fact -> pref. Index must move it.
    await db.set.memoryArtifact(Object.assign({}, b.toObject(), { type: 'pref' }));

    const facts = await db.get.memoryArtifactS.where({ type: 'fact' });
    const prefs = await db.get.memoryArtifactS.where({ type: 'pref' });
    expect(facts.map(x => x.$ID)).toEqual([a.$ID]);
    expect(prefs.map(x => x.$ID)).toEqual([b.$ID]);

    // Delete and re-check.
    await db.del.memoryArtifact(a.$ID);
    const facts2 = await db.get.memoryArtifactS.where({ type: 'fact' });
    expect(facts2).toEqual([]);
  });

  test('set that only touches non-indexed fields does not reshuffle compound keys', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      note: { type: String, required: false },
      $indexes: [['type']]
    });
    const row = await db.add.memoryArtifact({ type: 'fact', note: 'v1' });
    await db.set.memoryArtifact({ ...row.toObject(), note: 'v2' });
    const mgr = db._registry.secondaryIndexManager();
    const serialized = mgr.serialize().memoryArtifact[0];
    expect(serialized.data.keys).toContain(compoundKey(['fact']));
    const hits = await db.get.memoryArtifactS.where({ type: 'fact' }).toArray();
    expect(hits.some(h => String(h.$ID) === String(row.$ID))).toBe(true);
  });

  test('declaring an index on an undeclared field throws at startup', async () => {
    db = await freshDB();
    expect(() => {
      db.schema('memoryArtifact', {
        type: { type: String },
        $indexes: [['notAField']]
      });
    }).toThrow(/notAField/);
  });

  test('malformed $indexes entry throws', async () => {
    db = await freshDB();
    expect(() => {
      db.schema('memoryArtifact', {
        type: { type: String },
        $indexes: ['type']  // should be array of arrays
      });
    }).toThrow(/malformed.*\$indexes/i);
  });
});

describe('Secondary index persistence', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('indexes survive process restart', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      $indexes: [['type']]
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'pref' });
    await db._store.createSnapshot();
    await db.disconnect();

    db = await createDB({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      $indexes: [['type']]
    });
    const facts = await db.get.memoryArtifactS.where({ type: 'fact' });
    expect(facts).toHaveLength(2);
  });
});

describe('Bounded hydration with .where + .near', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('.where + .near with index-covered filter hydrates ~k, not the collection', async () => {
    // When the index fully covers the .where filter, no residual filter is
    // needed. The vector index runs against a candidate-set predicate, and
    // only the final k hits get hydrated.  Strong guarantee: hydration is
    // O(k), independent of collection size.
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      embedding: { type: 'vector', dims: 4, required: false },
      $indexes: [['type']]
    });
    const v = [1, 0, 0, 0];
    for (let i = 0; i < 50; i++) await db.add.memoryArtifact({ type: 'fact', embedding: v });
    for (let i = 0; i < 50; i++) await db.add.memoryArtifact({ type: 'pref', embedding: v });

    const realGet = db._store.get.bind(db._store);
    const reads = [];
    db._store.get = async function spiedGet(key, opts) {
      reads.push(key);
      return realGet(key, opts);
    };

    const facts = await db.get.memoryArtifactS
      .where({ type: 'fact' })
      .near(v, 5);

    db._store.get = realGet;

    expect(facts).toHaveLength(5);
    for (const f of facts) expect(f.type).toBe('fact');
    // Index-covered filter — only the k=5 final hits should hydrate. Tolerate
    // a small constant of extra reads (the engine may re-fetch via reactive
    // wrapping); assert we're nowhere near the 100 total.
    const memArtReads = reads.filter(k => k.startsWith('MECT_'));
    expect(memArtReads.length).toBeLessThan(20);
  });

  test('.where + .near with residual filter hydrates the candidate set, not the collection', async () => {
    // Compound index covers SESSION but not TYPE. The filter on session
    // narrows candidates via the index, but type is residual — so the
    // candidate set must be hydrated to apply the residual JS filter.
    // Hydration must be ~candidates, not the full collection.
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      session: { type: String, required: true },
      embedding: { type: 'vector', dims: 4, required: false },
      $indexes: [['session']]  // covers session, not type
    });
    const v = [1, 0, 0, 0];
    // 30 docs in session S1 (15 facts, 15 prefs); 70 docs in session S2.
    for (let i = 0; i < 15; i++) await db.add.memoryArtifact({ type: 'fact', session: 'S1', embedding: v });
    for (let i = 0; i < 15; i++) await db.add.memoryArtifact({ type: 'pref', session: 'S1', embedding: v });
    for (let i = 0; i < 70; i++) await db.add.memoryArtifact({ type: 'fact', session: 'S2', embedding: v });

    const realGet = db._store.get.bind(db._store);
    const reads = [];
    db._store.get = async function spiedGet(key, opts) {
      reads.push(key);
      return realGet(key, opts);
    };

    const hits = await db.get.memoryArtifactS
      .where({ session: 'S1', type: 'fact' })
      .near(v, 5);

    db._store.get = realGet;

    expect(hits).toHaveLength(5);
    for (const h of hits) {
      expect(h.session).toBe('S1');
      expect(h.type).toBe('fact');
    }
    // Candidate set is 30 (all S1 docs); hydration must be ~30, NOT 100.
    const memArtReads = reads.filter(k => k.startsWith('MECT_'));
    expect(memArtReads.length).toBeLessThan(70); // strictly less than the unindexed S2 set
  });
});
