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
