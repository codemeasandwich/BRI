/**
 * @file Smoke acceptance for workers/index-worker.js (spec §3.2).
 *
 * Goals:
 *   - The worker boundary works: requests cross the MessageChannel and
 *     responses come back without crashing.
 *   - Search results match the in-process VectorIndex bit-for-bit at
 *     small scale (the worker uses the same engine module, just hosted
 *     on a different thread).
 *   - The opCount diagnostic increments — proves the worker actually
 *     handled the requests rather than the host falling back to a
 *     hidden in-process path.
 *
 * Scope: this is a smoke check, not a perf gate. UC-V5 bulk-insert
 * non-blocking is exercised in tests/e2e/bulk.test.js. Scale latency
 * gates are exercised in tests/e2e/scale.test.js.
 *
 * @implements spec §3.2 (Worker Thread offload)
 */
import { jest } from '@jest/globals';
import { VectorIndex } from '../../src/engine/vector-index.js';
import {
  createWorkerVectorIndex,
  workerDiagnostics,
  disposeWorker
} from '../../src/workers/index-worker-host.js';

const DIMS = 8;

/** Deterministic synthetic vector generator. */
function vec(seed) {
  const out = new Array(DIMS);
  let s = seed;
  for (let i = 0; i < DIMS; i++) {
    s = (s * 9301 + 49297) % 233280;
    out[i] = s / 233280;
  }
  // Normalize so cosine similarity is well-defined.
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag);
  return out.map(v => v / mag);
}

describe('workers/index-worker (spec §3.2)', () => {
  afterAll(async () => {
    await disposeWorker();
  });

  test('search results match the main-thread VectorIndex top-k', async () => {
    const seed = 7;
    const main = new VectorIndex({ dims: DIMS, seed });
    const wkr = await createWorkerVectorIndex({
      collection: 'wktest_match', dims: DIMS, seed
    });

    for (let i = 0; i < 50; i++) {
      const v = vec(i + 1);
      main.add(`X_${i}`, v);
      await wkr.add(`X_${i}`, v);
    }

    const q = vec(123);
    const mainHits = main.search(q, 5).map(h => h.id);
    const wkrHits  = (await wkr.search(q, 5)).map(h => h.id);

    expect(wkrHits).toEqual(mainHits);
  });

  test('opCount increments — worker is genuinely doing the work', async () => {
    const before = (await workerDiagnostics()).opCount;
    const idx = await createWorkerVectorIndex({
      collection: 'wktest_diag', dims: DIMS
    });
    await idx.add('X_diag1', vec(1));
    await idx.add('X_diag2', vec(2));
    await idx.search(vec(3), 1);
    const after = (await workerDiagnostics()).opCount;
    expect(after).toBeGreaterThan(before + 2);
  });

  test('worker propagates typed errors back to the host', async () => {
    const idx = await createWorkerVectorIndex({
      collection: 'wktest_err', dims: DIMS
    });
    let thrown;
    try { await idx.add('X_err', [1, 2, 3]); }
    catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('VECTOR_DIMS_MISMATCH');
  });

  test('allowedIds set bounds candidates (UC-V1 acceptance criterion 3)', async () => {
    const idx = await createWorkerVectorIndex({
      collection: 'wktest_filter', dims: DIMS
    });
    for (let i = 0; i < 20; i++) {
      await idx.add(`Y_${i}`, vec(100 + i));
    }
    // Constrain to half the corpus.
    const allowed = ['Y_2', 'Y_4', 'Y_6', 'Y_8'];
    const hits = await idx.search(vec(105), 10, allowed);
    for (const h of hits) {
      expect(allowed).toContain(h.id);
    }
  });
});
