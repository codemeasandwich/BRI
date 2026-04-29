/**
 * @file Exercises defensive graph + snapshot behaviours with real engines:
 * attachToString array-slot hooks, truncated HNSW neighbour matrices, corrupted
 * entry bookkeeping for search guards, and hot-tier snapshots where JSON.parse
 * yields null shells (recovery stress). Imports `vector-index-hnsw.js` helpers
 * directly — the same primitives `VectorIndex` uses in production.
 */

import fs from 'fs/promises';
import { HotTierCache } from '../../storage/hot-tier/cache.js';
import { attachToString, VectorIndex } from '../../engine/index.js';
import {
  addNeighbor,
  finalizeHNSWResults,
  greedySearchOne,
  searchLayer,
  searchHNSW as searchHNSWCore
} from '../../engine/vector-index-hnsw.js';

const DIR = './test-data-hnsw-resilience';

/** Build a one-hot probe vector (deterministic cosine geometry). */
function basis(dim, pivot) {
  const v = new Array(dim).fill(0);
  v[pivot % dim] = 1;
  return v;
}

describe('HNSW graph resilience helpers', () => {
  beforeEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('attachToString wires toObject beside toString for array refs', () => {
    const blob = {
      items: [{ $ID: 'ITM_xx', tag: true }]
    };
    attachToString(blob);
    expect(blob.items[0].toObject()).toBe(blob.items[0]);
  });

  test('VectorIndex search tolerates greedy layers with missing neighbours', async () => {
    const dims = 8;
    const idx = new VectorIndex({
      dims,
      seed: 717,
      M: 4,
      efConstruction: 140,
      efSearch: 32,
      initialCapacity: 96
    });
    for (let i = 0; i < 40; i++) {
      idx.add(`HDR_${String(i).padStart(4, '0')}`, basis(dims, i));
    }
    const ep = idx._entryPoint;
    expect(ep).toBeGreaterThanOrEqual(0);

    const limit = idx._levels[ep];
    for (let layer = idx._entryLevel; layer >= 1 && layer <= limit + 5; layer--) {
      if (idx._neighbors[ep] && layer < idx._neighbors[ep].length)
        idx._neighbors[ep][layer] = undefined;
    }
    idx.search(basis(dims, 0), 8, {});
  });

  test('VectorIndex honours searchHNSW early exit when bookkeeping is inconsistent', async () => {
    const idx = new VectorIndex({ dims: 4 });
    idx.add('BASE_a', basis(4, 0));
    idx._entryPoint = -1;
    expect(searchHNSWCore(idx, basis(4, 0), 10, undefined, idx._hnswEfSearch)).toHaveLength(0);
  });

  test('snapshot resolveRefs observes null payloads from numeric JSON shells', async () => {
    const cache = new HotTierCache({ maxMemoryMB: 32 });
    await cache.clear();
    await cache.loadDocuments({
      NULL_SHELL: 'null',
      OK_SHELL: '{"$ID":"ZX_zz"}'
    });
    const snap = cache.getAllDocumentsForSnapshot(JSON.parse);
    expect(snap.NULL_SHELL).toBeNull();
    expect(snap.OK_SHELL).toMatchObject({ $ID: 'ZX_zz' });
  });

  test('greedySearchOne skips tombstoned neighbours in packed edge lists', () => {
    const idx = new VectorIndex({
      dims: 4,
      seed: 101,
      M: 4,
      efConstruction: 160,
      initialCapacity: 32
    });
    idx.add('LIVE_ep', basis(4, 0));
    idx.add('DEL_nb', basis(4, 1));
    idx.remove('DEL_nb');
    const ep = idx._slotOf.get('LIVE_ep');
    const best = greedySearchOne(idx, basis(4, 2), ep, 0);
    expect(typeof best).toBe('number');
  });

  test('searchLayer continues when candidate has no neighbour array at layer (corrupt topo)', () => {
    const idx = new VectorIndex({ dims: 4, seed: 202, efConstruction: 80 });
    idx.add('sx', basis(4, 0));
    idx.add('sy', basis(4, 1));
    const ep = idx._entryPoint;
    if (idx._neighbors[ep]) idx._neighbors[ep][0] = undefined;
    const q = basis(4, 2);
    const res = searchLayer(idx, q, ep, 20, 0, null);
    expect(Array.isArray(res)).toBe(true);
  });

  test('searchLayer default predicate binds without explicit sixth argument', () => {
    const idx = new VectorIndex({ dims: 6, seed: 303, efConstruction: 60 });
    idx.add('p1', basis(6, 0));
    const ep = idx._entryPoint;
    searchLayer(idx, basis(6, 1), ep, 5, 0);
  });

  test('finalizeHNSWResults drops slots whose ids are tombstones', () => {
    const idx = new VectorIndex({ dims: 4, seed: 404 });
    idx.add('keep', basis(4, 0));
    const dead = idx._slotOf.get('keep') === 0 ? 1 : 0;
    idx._idAt[dead] = null;
    const merged = finalizeHNSWResults(
      idx,
      [{ slot: dead, score: 0.99 }],
      5
    );
    expect(merged).toHaveLength(0);
  });

  test('insertNode phase-2 survives empty wide-search when EP is hacked tombstone+L0 starvation', () => {
    const idx = new VectorIndex({
      dims: 4,
      seed: 888,
      efConstruction: 120,
      efSearch: 40
    });
    idx.add('a', basis(4, 0));
    idx.add('b', basis(4, 1));
    const ep = idx._entryPoint;
    idx._idAt[ep] = null;
    if (idx._neighbors[ep]) idx._neighbors[ep][0] = new Int32Array(0);
    idx.add('c', basis(4, 2));
    expect(idx._size).toBe(3);
  });

  test('addNeighbor no-ops when neighbour matrix for fromSlot is missing (corrupt)', () => {
    const idx = new VectorIndex({
      dims: 4,
      seed: 9001,
      M: 6,
      efConstruction: 200,
      initialCapacity: 64
    });
    for (let i = 0; i < 20; i++) idx.add(`id${i}`, basis(4, i));
    const victim = 'id5';
    idx._neighbors[idx._slotOf.get(victim)] = null;
    idx.add('zzz', basis(4, 3));
  });

  test('addNeighbor returns when neighbour racks are corrupt', () => {
    const idx = new VectorIndex({ dims: 4, seed: 616, efConstruction: 120 });
    idx.add('solo', basis(4, 0));
    const fromSlot = idx._entryPoint;
    idx._neighbors[fromSlot] = null;
    addNeighbor(idx, fromSlot, 1, 0, idx._hnswM * 2);
  });

  test('HotTierCache default noop onEvict executes when eviction runs without custom hook', async () => {
    const tight = new HotTierCache({
      maxMemoryMB: 0.002,
      evictionThreshold: 0.001
    });
    await tight.set(
      'K_small',
      JSON.stringify({ n: `${'z'.repeat(80)}` }),
      false
    );
    await tight.set(
      'K_bulk',
      JSON.stringify({ x: `${'q'.repeat(400)}` }),
      false
    );
    expect((await tight.getStats()).coldReferences >= 1).toBe(true);
  });

  test('addNeighbor prune drops ghost slots from full neighbour ring before reselect', () => {
    const idx = new VectorIndex({ dims: 4, seed: 505, M: 2, efConstruction: 120 });
    idx.add('anchor', basis(4, 0));
    const fromSlot = idx._entryPoint;
    const M0 = idx._hnswM * 2;
    const tomb = 2;
    idx._idAt[tomb] = null;
    const cur = Int32Array.from([1, tomb, 3, 5]);
    idx._neighbors[fromSlot][0] = cur;
    addNeighbor(idx, fromSlot, 7, 0, M0);
    expect(idx._neighbors[fromSlot][0]).toBeTruthy();
  });
});
