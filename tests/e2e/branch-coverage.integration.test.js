/**
 * @file Exercises remaining Istanbul branch arms that statements/lines alone
 * left at 0 hits: optional-else paths, ternary second arms, short-circuit edges.
 * All cases go through real exports (openLocalDatabase, JSS, helpers, schema registry).
 * Includes hand-written snapshot/WAL directories for inhouse-recovery fallback
 * paths (v1/v2/v3 `|| {}`, cold/hot overlap, replay SET with non-array vector).
 */

import fs from 'fs/promises';
import path from 'path';
import { createDeleteEntry, createSetEntry } from '../../src/storage/wal/entry.js';
import { WALWriter } from '../../src/storage/wal/writer.js';
import { openLocalDatabase } from '../helpers/open-database.js';
import { createSchemaRegistry } from '../../src/engine/schema-registry.js';
import {
  buildOverlayObject,
  findMatchingItem,
  mapObjectOrArray
} from '../../src/engine/helpers.js';
import { undeclared } from '../../src/engine/constants.js';
import JSS from '../../src/utils/jss/index.js';
import { VectorIndex } from '../../src/engine/index.js';
const BASE = './test-data-branch-cover';

async function rmDir(d) {
  await fs.rm(d, { recursive: true, force: true }).catch(() => {});
}

describe('Branch coverage completions', () => {
  beforeEach(async () => rmDir(BASE));

  test('vector middleware skips body validation when add has undefined payload', async () => {
    const dir = `${BASE}-add-u`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('brAddU', { n: { type: Number } });
    await expect(Promise.resolve().then(() => db.add.brAddU())).rejects.toThrow();
    await db.disconnect();
  });

  test('vector del uses object selector so middleware parses id via $ID arm', async () => {
    const dir = `${BASE}-vecdel`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('brVecDel', {
      t: { type: String },
      emb: { type: 'vector', dims: 3 }
    });
    const d = await db.add.brVecDel({ t: 'a', emb: [0, 1, 0] });
    await db.del.brVecDel({ $ID: d.$ID }, 'SYS_bc');
    const rows = await db.get.brVecDelS();
    expect(rows.filter(Boolean).some((x) => x.$ID === d.$ID)).toBe(false);
    await db.disconnect();
  });

  test('touching() maps mixed string and entity seeds for edge collections', async () => {
    const dir = `${BASE}-touch`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brNode', { name: { type: String } });
    db.schema('brEdge', {
      from_id: { type: 'ref', to: 'brNode', required: true },
      to_id: { type: 'ref', to: 'brNode', required: true },
      kind: { type: String, required: true },
      $edge: { from: 'brNode', to: 'brNode', predicate: 'kind', predicates: '*' }
    });
    const a = await db.add.brNode({ name: 'A' });
    const b = await db.add.brNode({ name: 'B' });
    await db.add.brEdge({ from_id: a.$ID, to_id: b.$ID, kind: 'k' });
    const edges = await db.get.brEdgeS.touching([a.$ID, { $ID: b.$ID }]).toArray();
    expect(edges.some((e) => e.from_id === a.$ID && e.to_id === b.$ID)).toBe(true);
    await db.disconnect();
  });

  test('hydrate rejects non-array fields by clearing hydrate list', async () => {
    const dir = `${BASE}-hydr`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('brH', { x: { type: String } });
    await db.add.brH({ x: '1' });
    const rows = await db.get.brHS.hydrate('not-array').limit(10).toArray();
    expect(Array.isArray(rows)).toBe(true);
    await db.disconnect();
  });

  test('createSchemaRegistry() without store still declares schemas and predicates', () => {
    const reg = createSchemaRegistry();
    reg.declare('soloVec', {
      emb: { type: 'vector', dims: 2 }
    });
    expect(reg.inversePredicateEdge('none', 'p')).toBeUndefined();
    expect(Array.from(reg.predicatesForSubject('none'))).toHaveLength(0);
  });

  test('JSS encode skips assigning undefined-valued object keys per line-42 guard', () => {
    const enc = JSS.stringify({ keep: 'a', drop: undefined });
    expect(enc).toBeDefined();
    expect(enc.includes('"keep"')).toBe(true);
    const parsed = JSS.parse(enc);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'drop')).toBe(false);
  });

  test('helpers.findMatchingItem returns null when no id matches predicate', async () => {
    const ids = ['ID_a_x', 'ID_b_y', 'ID_c_z'];
    const hit = await findMatchingItem(ids, () => false, () => Promise.resolve(null));
    expect(hit).toBeNull();
  });

  test('helpers.mapObjectOrArray uses primitive oldRef sentinel path', () => {
    const tuples = mapObjectOrArray({ n: 1 }, [], '');
    expect(Array.isArray(tuples)).toBe(true);
  });

  test('helpers.buildOverlayObject creates empty subtree when walkwithsource misses', () => {
    const changes = [
      [['nested', 'k'], 'v']
    ];
    const out = buildOverlayObject(changes, {});
    expect(out.nested).toBeDefined();
  });

  test('helpers.buildOverlayObject allocates array branch when numeric path segment lacks source', () => {
    const out = buildOverlayObject([[['data', 0], 'cell']], {});
    expect(Array.isArray(out.data)).toBe(true);
    expect(out.data[0]).toBe('cell');
  });

  test('helpers.mapObjectOrArray marks nested leaf as undeclared when oldRef omits parent key', () => {
    const tuples = mapObjectOrArray({ a: { b: 1 } }, [], {});
    const leaf = tuples.find((t) => Array.isArray(t[0]) && t[0].join('.') === 'a.b');
    expect(leaf[2]).toBe(undeclared);
  });

  test('schema FIELD_TYPE_MISMATCH cites Vector label for vector declarations', async () => {
    const dir = `${BASE}-vec-label`;
    await rmDir(dir);
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('brVecLbl', {
      emb: { type: 'vector', dims: 2 }
    });
    await expect(db.add.brVecLbl({ emb: 'not-an-array' })).rejects.toThrow(/Vector \(numeric array\)/);
    await db.disconnect();
  });

  test('match execute path without numerical cap leaves slice unrestricted', async () => {
    const dir = `${BASE}-matchcap`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brMatch', {
      title: { type: String },
      updatedAt: { type: Date, required: false }
    });
    await db.add.brMatch({
      title: 'hello world match test',
      updatedAt: new Date('2025-01-02')
    });
    const rows = await db.get.brMatchS.where({}).match({ title: 'hello' }).toArray();
    expect(rows.length >= 1).toBe(true);
    await db.disconnect();
  });

  test('combined match+near assigns score metadata when blending', async () => {
    const dir = `${BASE}-comb`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brComb', {
      t: { type: String },
      e: { type: 'vector', dims: 2 }
    });
    await db.add.brComb({
      t: 'alias hit',
      e: [1, 0]
    });
    const q = await db.get.brCombS
      .where({})
      .match({ t: 'alias' })
      .near([1, 0], 5)
      .combine({ alias: 1, vector: 0.5 })
      .toArray();
    expect(q.length >= 1).toBe(true);
    await db.disconnect();
  });

  test('VectorIndex() default opts + explicit seed cover ctor default-arg and RNG branch', () => {
    expect(() => new VectorIndex()).toThrow(/dims|VECTOR_DIMS/i);
    const idx = new VectorIndex({ dims: 2, seed: 4242 });
    idx.add('id_x', [1, 0]);
    const h = idx.searchFiltered([1, 0], 1, null);
    expect(h.length >= 1).toBe(true);
  });

  test('VectorIndex RNG resolves BRI_VECTOR_RNG_SEED when ctor omits explicit seed', () => {
    const prev = process.env.BRI_VECTOR_RNG_SEED;
    try {
      process.env.BRI_VECTOR_RNG_SEED = '991';
      const idx = new VectorIndex({ dims: 2 });
      idx.add('rng_env_a', [1, 0]);
      expect(idx.searchFiltered([1, 0], 3, null).length).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.BRI_VECTOR_RNG_SEED;
      else process.env.BRI_VECTOR_RNG_SEED = prev;
    }
  });

  test('VectorIndex.searchInTxn throws when query dims disagree with indexed dims', () => {
    const idx = new VectorIndex({ dims: 2 });
    expect(() => idx.searchInTxn([1, 0, 1], 2, 't_cov', null)).toThrow(/dims|VECTOR_QUERY/i);
  });

  test('VectorIndex.searchInTxn runs with default null predicate parameter', () => {
    const idx = new VectorIndex({ dims: 2 });
    idx.add('stg_a', [1, 0]);
    idx.addStaged('tx_cov_default', 'stg_a', [1, 0]);
    const hits = idx.searchInTxn([1, 0], 3, 'tx_cov_default');
    expect(Array.isArray(hits)).toBe(true);
  });

  test('JSS.encode omits nested object keys whose value is explicit undefined', () => {
    const enc = JSS.encode({ nested: { keep: 'yes', dropChild: undefined } });
    const keys = Object.keys(enc).filter((k) => k.startsWith('nested'));
    expect(keys.some((k) => k.includes('dropChild'))).toBe(false);
    expect(JSON.stringify(enc).includes('"yes"')).toBe(true);
  });

  test('v2 snapshot docs without updatedAt still match; rankCompare ties at 0 missing timestamps', async () => {
    const dir = `${BASE}-snap-rank`;
    await rmDir(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const snap = {
      version: 2,
      walLine: 0,
      timestamp: new Date(),
      documents: {
        BRIE_a: { $ID: 'BRIE_a', title: 'alpha rank noclock substring' },
        BRIE_b: { $ID: 'BRIE_b', title: 'beta rank noclock substring' }
      },
      collections: { 'BRIE?': ['a', 'b'] }
    };
    await fs.writeFile(path.join(dir, 'snapshot.jss'), JSON.stringify(snap));
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brie', { title: { type: String }, updatedAt: { type: Date, required: false } });
    const rows = await db.get.brieS
      .where({})
      .match({ title: 'noclock' })
      .toArray();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    await db.disconnect();
  });

  test('combined query with empty filtered universe skips vector candidate prefetch branch', async () => {
    const dir = `${BASE}-comb-empty`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brEmpC', {
      t: { type: String },
      e: { type: 'vector', dims: 2 }
    });
    await db.add.brEmpC({ t: 'only', e: [1, 0] });
    const out = await db.get.brEmpCS
      .where({ t: '__no_matching_row_z__' })
      .match({ t: 'x' })
      .near([1, 0], 8)
      .combine({ alias: 1, vector: 0.5 })
      .toArray();
    expect(out).toEqual([]);
    await db.disconnect();
  });

  test('vector near with outer limit slices index plan without residual predicate', async () => {
    const dir = `${BASE}-vec-limslice`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('indexedRow', {
      session: { type: String },
      rowType: { type: String },
      e: { type: 'vector', dims: 2 },
      $indexes: [['session', 'rowType']]
    });
    for (let i = 0; i < 6; i++) {
      await db.add.indexedRow({ session: 'S', rowType: `r${i}`, e: [1, 0] });
    }
    const v = await db.get.indexedRowS
      .where({ session: 'S', rowType: 'r1' })
      .near([1, 0], 20)
      .limit(1)
      .toArray();
    expect(v.length).toBeLessThanOrEqual(1);
    await db.disconnect();
  });

  test('near query vector dim mismatch throws at execute (schema dims vs query length)', async () => {
    const dir = `${BASE}-near-badq`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('brBadQ', {
      t: { type: String },
      e: { type: 'vector', dims: 2 }
    });
    await db.add.brBadQ({ t: 'a', e: [1, 0] });
    await expect(db.get.brBadQS.near([1, 0, 1], 3).toArray()).rejects.toThrow(/dims|VECTOR_QUERY/i);
    await db.disconnect();
  });

  test('match on compound-index where plan uses hydrate filter branch', async () => {
    const dir = `${BASE}-match-idx-plan`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('indexedRow', {
      session: { type: String },
      rowType: { type: String },
      e: { type: 'vector', dims: 2 },
      extra: { type: String },
      $indexes: [['session', 'rowType']]
    });
    await db.add.indexedRow({ session: 'S', rowType: 'only', e: [1, 0], extra: 'tail' });
    const rows = await db.get.indexedRowS
      .where({ session: 'S', rowType: 'only' })
      .match({ rowType: 'on' })
      .toArray();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await db.disconnect();
  });

  test('groupBy with having only uses default count aggregation', async () => {
    const dir = `${BASE}-gb-having`;
    await rmDir(dir);
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brGb', { g: { type: String }, n: { type: Number } });
    await db.add.brGb({ g: 'a', n: 1 });
    await db.add.brGb({ g: 'a', n: 2 });
    await db.add.brGb({ g: 'b', n: 3 });
    const rows = await db.get.brGbS
      .where({})
      .groupBy('g')
      .having({ count: { $gte: 2 } })
      .toArray();
    expect(rows.some((r) => r.g === 'a' && r.count === 2)).toBe(true);
    expect(rows.some((r) => r.g === 'b')).toBe(false);
    await db.disconnect();
  });

  test('indexed where with limit slices after index hydrate (useIndex + numeric limit)', async () => {
    const dir = `${BASE}-qbw-lim`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brIdxLim', {
      session: { type: String },
      rowType: { type: String },
      $indexes: [['session', 'rowType']]
    });
    await db.add.brIdxLim({ session: 'S', rowType: 'z1' });
    await db.add.brIdxLim({ session: 'S', rowType: 'z2' });
    await db.add.brIdxLim({ session: 'S', rowType: 'z3' });
    const rows = await db.get.brIdxLimS.where({ session: 'S' }).limit(2).toArray();
    expect(rows.length).toBe(2);
    await db.disconnect();
  });

  test('touching seeds may include opaque objects without $ID (filtered from id set)', async () => {
    const dir = `${BASE}-touch-obj`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('brNodeTO', { name: { type: String } });
    db.schema('brEdgeTO', {
      from_id: { type: 'ref', to: 'brNodeTO', required: true },
      to_id: { type: 'ref', to: 'brNodeTO', required: true },
      kind: { type: String, required: true },
      $edge: { from: 'brNodeTO', to: 'brNodeTO', predicate: 'kind', predicates: '*' }
    });
    const a = await db.add.brNodeTO({ name: 'A' });
    const b = await db.add.brNodeTO({ name: 'B' });
    await db.add.brEdgeTO({ from_id: a.$ID, to_id: b.$ID, kind: 'k' });
    const edges = await db.get.brEdgeTOS.touching([a.$ID, { notAnEntity: true }]).toArray();
    expect(edges.some((e) => e.from_id === a.$ID)).toBe(true);
    const noSeeds = await db.get.brEdgeTOS.touching(null).toArray();
    expect(Array.isArray(noSeeds)).toBe(true);
    await db.disconnect();
  });

  test('near with index-backed where and residual filter hydrates candidates for vector predicate', async () => {
    const dir = `${BASE}-near-idx-res`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 80 } });
    db.schema('brNearIdx', {
      session: { type: String },
      rowType: { type: String },
      e: { type: 'vector', dims: 2 },
      $indexes: [['session']]
    });
    await db.add.brNearIdx({ session: 'S', rowType: 'keep', e: [1, 0] });
    await db.add.brNearIdx({ session: 'S', rowType: 'drop', e: [0, 1] });
    const hits = await db.get.brNearIdxS
      .where({ session: 'S', rowType: 'keep' })
      .near([1, 0], 5)
      .toArray();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    await db.disconnect();
  });

  test('near with full-scan where residual (no declared secondary index)', async () => {
    const dir = `${BASE}-near-scan`;
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 80 } });
    db.schema('brNearScan', {
      tag: { type: String },
      e: { type: 'vector', dims: 2 }
    });
    await db.add.brNearScan({ tag: 'hit', e: [1, 0] });
    await db.add.brNearScan({ tag: 'miss', e: [0, 1] });
    const rows = await db.get.brNearScanS.where({ tag: 'hit' }).near([1, 0], 4).toArray();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    await db.disconnect();
  });

  /**
   * Domain: recovering from disk must tolerate partial snapshot payloads (`|| {}`
   * fallbacks), WAL lines that omit vector-compatible bodies, deletes on oddly
   * shaped keys, and cold-tier listings that duplicate keys already in the hot map.
   * Technical: hand-author snapshot.jss + append WAL segments before boot so
   * inhouse-recovery runs without shortcuts (real loadLatest + WALReader.replay).
   */
  test('recovery v3 snapshot omits documents/collections; WAL SET skips non-array vector field', async () => {
    const dir = `${BASE}-rec-v3omit`;
    await rmDir(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    // Omit `documents`/`collections`; vectorSchemas declares vcBare without
    // metric so loadVectorState uses the cosine default (`metric || 'cosine'`).
    const snap = {
      version: 3,
      walLine: 0,
      timestamp: new Date(),
      vectorSchemas: {
        vcBare: { field: 'emb', dims: 2 }
      },
      vectorIndices: {}
    };
    await fs.writeFile(path.join(dir, 'snapshot.jss'), JSON.stringify(snap));

    const w = new WALWriter(path.join(dir, 'wal'), { fsyncMode: 'always' });
    await w.init();
    await w.append(createDeleteEntry('nodeleteunderscore'));
    await w.append(
      createSetEntry(
        'VCRE_emb',
        JSS.stringify({ $ID: 'VCRE_emb', emb: 'broken-not-array', updatedAt: new Date(), createdAt: new Date() })
      )
    );
    await w.close();

    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('vcBare', { emb: { type: 'vector', dims: 2 } });
    // Replay feeds hotTier.set only (no WAL SADD for catalog); verify by primary key fetch.
    const row = await db.get.vcBare('VCRE_emb');
    expect(row).not.toBeNull();
    expect(row.emb).toBe('broken-not-array');
    await db.disconnect();
  });

  test('recovery applies v2 snapshot when documents/collections keys are omitted', async () => {
    const dir = `${BASE}-rec-v2omit`;
    await rmDir(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const snap = {
      version: 2,
      walLine: 0,
      timestamp: new Date()
    };
    await fs.writeFile(path.join(dir, 'snapshot.jss'), JSON.stringify(snap));
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    expect(db).toBeDefined();
    await db.disconnect();
  });

  test('recovery v1 snapshot uses {} when documents and collections are null', async () => {
    const dir = `${BASE}-rec-v1null`;
    await rmDir(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const snap = {
      version: 1,
      walLine: 0,
      timestamp: new Date(),
      documents: null,
      collections: null
    };
    await fs.writeFile(path.join(dir, 'snapshot.jss'), JSON.stringify(snap));
    const db = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    expect(db).toBeDefined();
    await db.disconnect();
  });

  test('recovery skips cold marker when snapshot already loaded the doc into hot tier', async () => {
    const dir = `${BASE}-rec-coldoverlap`;
    await rmDir(dir);
    const db1 = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    const u = await db1.add.user({ name: 'overlap-cold-hot' });
    await db1._store.createSnapshot();
    await db1.disconnect();
    const match = u.$ID.match(/^(.+)_(.+)$/);
    const short = match[1];
    const idTail = match[2];
    await fs.mkdir(path.join(dir, 'cold', short), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'cold', short, `${idTail}.jss`),
      '{"$ID":"' + u.$ID + '","name":"overlap-cold-hot","coldShadow":true}',
      'utf8'
    );
    const db2 = await openLocalDatabase({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    const again = await db2.get.user(u.$ID);
    expect(again).not.toBeNull();
    expect(again.name).toBe('overlap-cold-hot');
    await db2.disconnect();
  });
});
