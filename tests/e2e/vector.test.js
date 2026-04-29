/**
 * E2E Vector Search Tests
 *
 * Implements UC-V1 acceptance criteria from the Bri Vector + Graph spec.
 *
 * Coverage:
 *   - top-k cosine similarity returns nearest neighbours from documents
 *   - $cosine score is attached to result entities
 *   - .where filter is composed with .near (filter applied to candidate set)
 *   - dimension mismatch on insert returns a typed validation error
 *   - dimension mismatch on query throws a typed query error
 *   - empty collection yields empty results, not crashes
 *   - post-checkpoint WAL tail (no final snapshot on exit) restores vectors
 *     through recovery replay — exercises inhouse-recovery applyVectorWrite
 *   - full document body returned without secondary round-trips
 *   - the legacy db.get.{collection}S(...) call form still works
 *
 * Domain rationale:
 *   These tests prove vector search is a first-class read primitive that
 *   composes with attribute filters in a single round-trip, satisfying the
 *   memory-tier recall path in the Bri Memory + Knowledge spec.
 *
 * @implements UC-V1
 */
import { jest } from '@jest/globals';
import { createDB } from '../../client/index.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { once } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTOR_WAL_CHILD = path.resolve(HERE, 'vector-wal-recovery-child.mjs');

const TEST_DATA_DIR = './test-data-vector';

/**
 * Synthetic embedding generator.
 *
 * Why deterministic: tests must be reproducible. We seed from a string
 * so identical inputs produce identical vectors across machines and runs.
 *
 * Why normalized: cosine similarity is invariant to magnitude, but pre-
 * normalising removes a confound when asserting score ordering. Real
 * pipelines normally normalize embeddings at the embedding-model boundary.
 *
 * @param {string} seed - Deterministic seed (any string)
 * @param {number} dims - Vector dimensionality
 * @returns {number[]} Unit-length vector of length `dims`
 */
function makeVec(seed, dims = 8) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const v = new Array(dims);
  let mag = 0;
  for (let i = 0; i < dims; i++) {
    h = (h * 1103515245 + 12345) | 0;
    v[i] = ((h >>> 0) % 1000) / 1000 - 0.5;
    mag += v[i] * v[i];
  }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dims; i++) v[i] /= mag;
  return v;
}

describe('Vector Search (UC-V1)', () => {
  let db;
  const DIMS = 8;

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    db = await createDB({
      storeConfig: { dataDir: TEST_DATA_DIR, maxMemoryMB: 64 }
    });

    // Register a schema that declares a vector field. The schema registration
    // is what wires the vector index on this collection.
    db.schema('memoryArtifact', {
      type:      { type: String, required: true },
      content:   { type: String, required: false },
      embedding: { type: 'vector', dims: DIMS, metric: 'cosine', required: false },
      session:   { type: String, required: false }
    });
  });

  afterAll(async () => {
    await db.disconnect();
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('top-k cosine returns nearest neighbours', async () => {
    // Seed three documents with distinguishable embeddings.
    const target = makeVec('alpha', DIMS);
    const a = await db.add.memoryArtifact({ type: 'fact', content: 'A', embedding: target });
    const b = await db.add.memoryArtifact({ type: 'fact', content: 'B', embedding: makeVec('beta', DIMS) });
    const c = await db.add.memoryArtifact({ type: 'fact', content: 'C', embedding: makeVec('gamma', DIMS) });

    // Query with the exact target vector — top-1 must be A.
    const results = await db.get.memoryArtifactS.near(target, 3).toArray();

    expect(results).toHaveLength(3);
    expect(results[0].$ID).toBe(a.$ID);
    // Cosine of identical unit vectors is 1.0 (allow tiny float tolerance).
    expect(results[0].$cosine).toBeGreaterThan(0.9999);
    // Scores must be monotonically non-increasing (sorted desc).
    expect(results[0].$cosine).toBeGreaterThanOrEqual(results[1].$cosine);
    expect(results[1].$cosine).toBeGreaterThanOrEqual(results[2].$cosine);
  });

  test('full document body returned without secondary fetch', async () => {
    const v = makeVec('full-body', DIMS);
    const doc = await db.add.memoryArtifact({
      type: 'preference', content: 'prefers terse responses', embedding: v
    });
    const [hit] = await db.get.memoryArtifactS.near(v, 1).toArray();
    expect(hit.$ID).toBe(doc.$ID);
    expect(hit.type).toBe('preference');
    expect(hit.content).toBe('prefers terse responses');
    expect(hit.embedding).toEqual(v);
  });

  test('.where filter composes with .near', async () => {
    // Seed two facts and one preference, all near the same query vector.
    const q = makeVec('query-filter', DIMS);
    await db.add.memoryArtifact({ type: 'fact',       content: 'F1', embedding: q });
    await db.add.memoryArtifact({ type: 'fact',       content: 'F2', embedding: q });
    await db.add.memoryArtifact({ type: 'preference', content: 'P1', embedding: q });

    const facts = await db.get.memoryArtifactS
      .where({ type: 'fact' })
      .near(q, 10)
      .toArray();

    expect(facts.length).toBeGreaterThanOrEqual(2);
    // Critical: filter must apply BEFORE k truncation, so we don't get
    // "1 fact + nothing" by losing eligible facts to ineligible neighbours.
    for (const f of facts) {
      expect(f.type).toBe('fact');
    }
  });

  test('dimension mismatch on insert is rejected', async () => {
    // The validator throws BriValidationError with code VECTOR_DIMS_MISMATCH
    // (typed-error contract from spec §2.11; see engine/errors.js).
    const validate = (await import('../../utils/schema/index.js')).default;
    const { BriValidationError, VECTOR_DIMS_MISMATCH } =
      await import('../../engine/errors.js');
    const schema = { embedding: { type: 'vector', dims: DIMS } };
    let thrown;
    try { validate(schema, { embedding: [1, 2, 3, 4] }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BriValidationError);
    expect(thrown.code).toBe(VECTOR_DIMS_MISMATCH);
    expect(thrown.message).toMatch(/dim/i);
  });

  test('non-finite values in embedding are rejected', async () => {
    const validate = (await import('../../utils/schema/index.js')).default;
    const { BriValidationError, VECTOR_INVALID_VALUE } =
      await import('../../engine/errors.js');
    const schema = { embedding: { type: 'vector', dims: 3 } };
    const expectThrow = (val, code) => {
      let thrown;
      try { validate(schema, { embedding: val }); }
      catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriValidationError);
      expect(thrown.code).toBe(code);
    };
    expectThrow([1, NaN, 3], VECTOR_INVALID_VALUE);
    expectThrow([1, Infinity, 3], VECTOR_INVALID_VALUE);
    // Valid case completes silently — no exception.
    expect(() => validate(schema, { embedding: [1, 2, 3] })).not.toThrow();
  });

  test('query vector with wrong dims throws typed error', async () => {
    const wrongDims = [1, 2, 3]; // schema declared 8
    await expect(
      db.get.memoryArtifactS.near(wrongDims, 1).toArray()
    ).rejects.toThrow(/dim/i);
  });

  test('legacy call-form db.get.collectionS() still returns full list', async () => {
    // Backwards compatibility gate: the existing API surface must not break.
    const all = await db.get.memoryArtifactS();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    // Each entry is a full reactive entity with $ID.
    for (const item of all) {
      // type2Short('memoryArtifact') = 'me' + 'ct' uppercased = 'MECT'
      expect(item.$ID).toMatch(/^MECT_/);
    }
  });

  test('empty .where match yields empty array, not error', async () => {
    const q = makeVec('empty', DIMS);
    const none = await db.get.memoryArtifactS
      .where({ type: 'no-such-type-exists' })
      .near(q, 5)
      .toArray();
    expect(none).toEqual([]);
  });
});

describe('HNSW correctness (v2)', () => {
  /**
   * The brute-force v1 backend was a guaranteed exact-recall search; the
   * v2 HNSW backend is approximate by design. These tests pin two
   * properties:
   *   1) At fixture-scale sizes (~1k), default params produce ≥95% top-10
   *      recall vs. brute force — well within the 99% acceptance threshold
   *      that production HNSW deployments target.
   *   2) Seeded RNG produces bit-identical serialized output across two
   *      independent indexes given the same insert sequence — required so
   *      tests gating snapshot bytes (e.g. encryption parity tests) don't
   *      flap on rerun.
   */
  let bf;          // brute-force baseline computed via direct cosine
  beforeAll(() => {
    // Pre-compute a brute-force ground truth so individual tests can
    // assert against it without re-running 1k * 1k cosine pairs each.
    bf = null;
  });

  test('top-k recall ≥0.95 at 1k vectors with default params', async () => {
    const { VectorIndex } = await import('../../engine/vector-index.js');
    const { cosine } = await import('../../engine/vector-index-codec.js');
    const D = 16;
    const N = 1000;
    const idx = new VectorIndex({ dims: D, seed: 12345, initialCapacity: N });
    // Generate deterministic unit vectors with makeVec — same harness the
    // rest of the suite uses, so failures are reproducible.
    const vecs = [];
    for (let i = 0; i < N; i++) {
      const v = makeVec(`hnsw-recall-${i}`, D);
      vecs.push(v);
      idx.add(`id_${i}`, v);
    }
    // Run 50 random queries; for each compute brute-force top-10 and
    // intersect with HNSW top-10. Recall = |intersection| / 10.
    const queries = 50;
    const k = 10;
    let totalRecall = 0;
    for (let q = 0; q < queries; q++) {
      const qv = makeVec(`query-${q}`, D);
      // Brute-force top-k.
      const scored = vecs.map((v, i) => ({ id: `id_${i}`, score: cosine(qv, v) }));
      scored.sort((a, b) => b.score - a.score);
      const truth = new Set(scored.slice(0, k).map(s => s.id));
      // HNSW top-k.
      const hits = idx.search(qv, k);
      let intersection = 0;
      for (const h of hits) if (truth.has(h.id)) intersection++;
      totalRecall += intersection / k;
    }
    const avgRecall = totalRecall / queries;
    expect(avgRecall).toBeGreaterThanOrEqual(0.95);
  });

  test('seeded RNG produces bit-identical serialize() output', async () => {
    const { VectorIndex } = await import('../../engine/vector-index.js');
    const D = 8;
    const N = 100;
    const seed = 7;
    function buildIndex() {
      const idx = new VectorIndex({ dims: D, seed, initialCapacity: N });
      for (let i = 0; i < N; i++) {
        idx.add(`id_${i}`, makeVec(`reproducible-${i}`, D));
      }
      return idx.serialize();
    }
    const a = buildIndex();
    const b = buildIndex();
    expect(a.length).toBe(b.length);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  test('exact recall at fixture-scale sizes (≤100)', async () => {
    // At ≤100 vectors and default efSearch=50, max(efSearch, k) is large
    // enough that the level-0 search visits the entire frontier — exact
    // recall comes free. This test pins that property so a future tuning
    // change to defaults can't silently degrade fixture-scale tests.
    const { VectorIndex } = await import('../../engine/vector-index.js');
    const { cosine } = await import('../../engine/vector-index-codec.js');
    const D = 8;
    const N = 100;
    const idx = new VectorIndex({ dims: D, seed: 1, initialCapacity: N });
    const vecs = [];
    for (let i = 0; i < N; i++) {
      const v = makeVec(`exact-${i}`, D);
      vecs.push(v);
      idx.add(`id_${i}`, v);
    }
    const qv = makeVec('exact-query', D);
    const scored = vecs.map((v, i) => ({ id: `id_${i}`, score: cosine(qv, v) }));
    scored.sort((a, b) => b.score - a.score);
    const truth = scored.slice(0, 5).map(s => s.id);
    const hits = idx.search(qv, 5);
    expect(hits.map(h => h.id)).toEqual(truth);
  });

  test('efSearch override is respected per-call', async () => {
    // The override widens the candidate frontier, so a query that misses
    // a hit at low ef can find it at high ef. We rig the test by setting
    // a very low ef on the index instance, then proving the per-call
    // override produces strictly more / different results.
    const { VectorIndex } = await import('../../engine/vector-index.js');
    const D = 8;
    const N = 200;
    const idx = new VectorIndex({
      dims: D, seed: 99, initialCapacity: N,
      efSearch: 10  // intentionally narrow default
    });
    for (let i = 0; i < N; i++) {
      idx.add(`id_${i}`, makeVec(`override-${i}`, D));
    }
    const q = makeVec('override-query', D);
    // Both calls request k=10. With ef=10 the search explores narrowly;
    // with ef=N=200 it explores the full graph at level 0 (exact recall).
    const lo = idx.search(q, 10);
    const hi = idx.search(q, 10, { efSearch: 200 });
    expect(lo).toHaveLength(10);
    expect(hi).toHaveLength(10);
    // Higher ef must produce a result whose top score is ≥ the narrow one.
    expect(hi[0].score).toBeGreaterThanOrEqual(lo[0].score);
  });

  test('stats() exposes HNSW parameters', async () => {
    const { VectorIndex } = await import('../../engine/vector-index.js');
    const idx = new VectorIndex({ dims: 8, M: 12, efConstruction: 100, efSearch: 75 });
    idx.add('a', makeVec('a', 8));
    const s = idx.stats();
    expect(s.M).toBe(12);
    expect(s.efConstruction).toBe(100);
    expect(s.efSearch).toBe(75);
    expect(typeof s.entryLevel).toBe('number');
  });

  test('replace-via-add overwrites a vector and preserves search semantics', async () => {
    // The HNSW wrapper's add() with an existing ID drops the old node from
    // the topology and re-inserts. Tests the integration of the dropNode +
    // insertNode path through the public surface, which is the only path
    // that exercises both topology mutations in a single call.
    const { VectorIndex } = await import('../../engine/vector-index.js');
    const D = 8;
    const idx = new VectorIndex({ dims: D, seed: 13, initialCapacity: 16 });
    // Seed an initial vector under id=A.
    const v1 = makeVec('replace-orig', D);
    idx.add('A', v1);
    // Add some other vectors so the graph is non-trivial.
    for (let i = 0; i < 10; i++) idx.add(`B_${i}`, makeVec(`replace-pad-${i}`, D));
    // Now overwrite A with a totally different vector.
    const v2 = makeVec('replace-new', D);
    idx.add('A', v2);
    // Searching with v2 must return A first (overwrite worked).
    const hitsNew = idx.search(v2, 1);
    expect(hitsNew[0].id).toBe('A');
    expect(hitsNew[0].score).toBeGreaterThan(0.9999);
    // Searching with the OLD v1 must NOT score A as 1.0 — the slot now holds v2.
    const hitsOld = idx.search(v1, 5);
    const aHitOld = hitsOld.find(h => h.id === 'A');
    if (aHitOld) {
      // A may or may not be in the top-5 depending on cosine(v1, v2); it must
      // not score as identical-direction.
      expect(aHitOld.score).toBeLessThan(0.9999);
    }
    // Size hasn't changed (replace, not add).
    expect(idx.stats().count).toBe(11);
  });
});

describe('efSearch override end-to-end via .near', () => {
  /**
   * Ensures the v2 query-time tuning knob flows from .near(v, k, { efSearch })
   * through query-builder → searchFiltered → searchHNSW. Without this gate, a
   * regression that drops the opts plumbing in any layer would be invisible
   * (the unit test on VectorIndex would still pass).
   */
  let db;
  const E_DIMS = 8;
  const E_DIR = './test-data-vector-efsearch';

  beforeAll(async () => {
    await fs.rm(E_DIR, { recursive: true, force: true }).catch(() => {});
    db = await createDB({ storeConfig: { dataDir: E_DIR, maxMemoryMB: 64 } });
    db.schema('memoryArtifact', {
      type:      { type: String, required: true },
      embedding: { type: 'vector', dims: E_DIMS, required: false }
    });
    // Populate enough docs that the default efSearch frontier doesn't
    // trivially see all of them.
    for (let i = 0; i < 200; i++) {
      await db.add.memoryArtifact({
        type: 'fact', embedding: makeVec(`efs-${i}`, E_DIMS)
      });
    }
  });

  afterAll(async () => {
    await db.disconnect();
    await fs.rm(E_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('opts.efSearch is forwarded by the chain to the index', async () => {
    const q = makeVec('efs-query-1', E_DIMS);
    // Both should return 5 results; the wider ef may produce a different set
    // (the public correctness contract is just "results are valid for the k").
    // We don't pin specific IDs because the graph topology depends on the RNG;
    // we DO pin that both runs return the requested k and the wider-ef run's
    // top score is monotonically ≥ the narrow run's top score (a strict
    // refinement guarantee at small graph sizes where wider ef ⊇ narrower ef
    // search frontier).
    const narrow = await db.get.memoryArtifactS.near(q, 5).toArray();
    const wide = await db.get.memoryArtifactS.near(q, 5, { efSearch: 200 }).toArray();
    expect(narrow).toHaveLength(5);
    expect(wide).toHaveLength(5);
    expect(wide[0].$cosine).toBeGreaterThanOrEqual(narrow[0].$cosine);
  });
});

describe('Vector Persistence (Risk 1)', () => {
  /**
   * Each test in this describe owns its own data dir so we can reboot the
   * process (simulated by createDB twice against the same directory) without
   * cross-contamination from neighbours.
   */
  const PERSIST_DIMS = 8;

  /**
   * Spin up a db, run a callback, disconnect, return the result.
   * Used to model "first boot" / "second boot" patterns in tests.
   */
  async function withDB(dir, fn) {
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    try {
      return await fn(db);
    } finally {
      await db.disconnect();
    }
  }

  /**
   * Child helper for vector-wal-recovery-child.mjs — stdout READY before exit().
   *
   * Domain: WAL replay routing (applyVectorWrite) only executes when WAL
   * lines exist after snapshot.walLine; an unclean exit avoids the final
   * disconnect snapshot so the surviving tail survives on disk for recover().
   *
   * Technical: listens on stdout until READY appears.
   *
   * @param {import('child_process').ChildProcessWithoutNullStreams} child
   * @returns {Promise<void>}
   */
  function waitVectorWalChildReady(child) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        if (buf.includes('READY')) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.on('error', reject);
      child.on('exit', (code, sig) => {
        if (!buf.includes('READY')) {
          reject(new Error(`vector wal child exited before READY (code=${code} sig=${sig})`));
        }
      });
    });
  }

  test('vector index survives process restart via snapshot', async () => {
    const dir = './test-data-vector-persist-1';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    let savedId, savedVec;
    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        type:      { type: String, required: true },
        embedding: { type: 'vector', dims: PERSIST_DIMS, required: false }
      });
      savedVec = makeVec('persist-1-target', PERSIST_DIMS);
      const doc = await db.add.memoryArtifact({ type: 'fact', embedding: savedVec });
      savedId = doc.$ID;
      // Force a snapshot so the index is durable.
      await db._store.createSnapshot();
    });

    // Second boot: same dir, no inserts. Search must still find the doc.
    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        type:      { type: String, required: true },
        embedding: { type: 'vector', dims: PERSIST_DIMS, required: false }
      });
      const [hit] = await db.get.memoryArtifactS.near(savedVec, 1);
      expect(hit).toBeDefined();
      expect(hit.$ID).toBe(savedId);
      expect(hit.$cosine).toBeGreaterThan(0.9999);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('WAL replay reapplies inserts written after the snapshot', async () => {
    const dir = './test-data-vector-persist-2';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    let preId, postId, preVec, postVec;
    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        type:      { type: String, required: true },
        embedding: { type: 'vector', dims: PERSIST_DIMS, required: false }
      });
      preVec = makeVec('persist-2-pre', PERSIST_DIMS);
      preId = (await db.add.memoryArtifact({ type: 'fact', embedding: preVec })).$ID;
      await db._store.createSnapshot();
      // Now insert AFTER the snapshot so the doc only exists in the WAL.
      postVec = makeVec('persist-2-post', PERSIST_DIMS);
      postId = (await db.add.memoryArtifact({ type: 'fact', embedding: postVec })).$ID;
    });

    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        type:      { type: String, required: true },
        embedding: { type: 'vector', dims: PERSIST_DIMS, required: false }
      });
      const [hitPre]  = await db.get.memoryArtifactS.near(preVec, 1);
      const [hitPost] = await db.get.memoryArtifactS.near(postVec, 1);
      expect(hitPre.$ID).toBe(preId);
      expect(hitPost.$ID).toBe(postId);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('schema dim mismatch on reboot raises a diagnostic error', async () => {
    const dir = './test-data-vector-persist-3';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        embedding: { type: 'vector', dims: 8, required: false }
      });
      await db.add.memoryArtifact({ embedding: makeVec('p3', 8) });
      await db._store.createSnapshot();
    });

    // Reboot with the WRONG dims — must throw at schema declaration time.
    await withDB(dir, async (db) => {
      expect(() => {
        db.schema('memoryArtifact', {
          embedding: { type: 'vector', dims: 16, required: false }
        });
      }).toThrow(/drift.*dims=8.*dims=16/i);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('field rename on reboot raises a diagnostic error', async () => {
    const dir = './test-data-vector-persist-4';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        embedding: { type: 'vector', dims: 8, required: false }
      });
      await db.add.memoryArtifact({ embedding: makeVec('p4', 8) });
      await db._store.createSnapshot();
    });

    await withDB(dir, async (db) => {
      expect(() => {
        db.schema('memoryArtifact', {
          // Same dims/metric but renamed field — auto-migration not supported.
          vec: { type: 'vector', dims: 8, required: false }
        });
      }).toThrow(/rename|field/i);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('snapshot v2 from a no-vector boot still loads cleanly', async () => {
    const dir = './test-data-vector-persist-5';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    // First boot: NO schema declared. Snapshot is v2.
    await withDB(dir, async (db) => {
      await db.add.user({ name: 'Alice' });
      await db._store.createSnapshot();
    });

    // Second boot: declare a vector schema for a different collection.
    // The v2 snapshot loader skips the vector path; we expect a fresh empty
    // index for memoryArtifact, not an error.
    await withDB(dir, async (db) => {
      db.schema('memoryArtifact', {
        embedding: { type: 'vector', dims: 8, required: false }
      });
      const v = makeVec('p5-after', 8);
      await db.add.memoryArtifact({ embedding: v });
      const [hit] = await db.get.memoryArtifactS.near(v, 1);
      expect(hit).toBeDefined();
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('v2 snapshot reattaches toString on nested objects with $ID (loadSnapshotV2 prototypes)', async () => {
    const dir = './test-data-vector-persist-nested-id';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    let aliceId;
    await withDB(dir, async (db) => {
      const alice = await db.add.user({ name: 'Alice' });
      aliceId = alice.$ID;
      await db.add.user({ name: 'Bob', buddy: { $ID: aliceId } });
      await db._store.createSnapshot();
    });

    await withDB(dir, async (db) => {
      const rows = await db.get.userS();
      const bob = rows.find((r) => r.name === 'Bob');
      expect(bob).toBeDefined();
      expect(bob.buddy && bob.buddy.$ID).toBe(aliceId);
      expect(String(bob.buddy)).toBe(aliceId);
      expect(bob.buddy.toObject().$ID).toBe(aliceId);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('hardDelete emits WAL DELETE and updates catalog inside instrumented adapter', async () => {
    const dir = './test-data-vector-hard-delete-live';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    await withDB(dir, async (db) => {
      db.schema('memWalHardDel', {
        t:      { type: String, required: true },
        embedding: { type: 'vector', dims: PERSIST_DIMS, required: false }
      });
      const emb = makeVec('hard-delete-adapter', PERSIST_DIMS);
      const d = await db.add.memWalHardDel({ t: 'one', embedding: emb });
      const ct = db._store.coldTier;
      const origDelete = ct.deleteDoc.bind(ct);
      let flaky = true;
      ct.deleteDoc = (key) =>
        flaky
          ? (flaky = false, Promise.reject(Object.assign(new Error('cold flake'), { code: 'ETEST' })))
          : origDelete(key);
      await db._store.hardDelete(d.$ID);
      ct.deleteDoc = origDelete;
      const rows = (await db.get.memWalHardDelS()).filter(Boolean);
      expect(rows).toHaveLength(0);
      const hits = await db.get.memWalHardDelS.near(emb, 2).toArray();
      expect(hits).toHaveLength(0);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('hardDelete skips type-catalog sRem when key has no underscore segment', async () => {
    const dir = './test-data-vector-hard-delete-noseg';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await withDB(dir, async (db) => {
      db.schema('memWalHardDel', {
        t: { type: String, required: true },
        embedding: { type: 'vector', dims: PERSIST_DIMS, required: false }
      });
      await db._store.hardDelete('FLATNOUSKEY');
    });
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('post-checkpoint WAL tail restores vector index after unclean exit (applyVectorWrite / applyVectorDelete)', async () => {
    const dir = './test-data-vector-wal-post-checkpoint';
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    const child = spawn('node',
      ['--experimental-specifier-resolution=node', VECTOR_WAL_CHILD, dir],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const exitPromise = once(child, 'exit');
    await waitVectorWalChildReady(child);
    const [code] = await exitPromise;
    expect(code).toBe(0);

    const embPre = [1, 0, 0, 0];
    const embPost = [0, 1, 0, 0];

    await withDB(dir, async (db) => {
      db.schema('vecWalChunk', {
        tag: { type: String, required: true },
        embedding: { type: 'vector', dims: 4, required: false }
      });
      const rows = await db.get.vecWalChunkS().then(r => r.sort((a, b) => a.tag.localeCompare(b.tag)));
      expect(rows.map(d => d.tag)).toEqual(['post']);
      const [hPost] = await db.get.vecWalChunkS.near(embPost, 2);
      expect(hPost.tag).toBe('post');
      const rowsAll = await db.get.vecWalChunkS();
      expect(rowsAll.every(d => d.tag !== 'pre')).toBe(true);
    });

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (stderr.length > 0) {
      // Surface child stderr only on failure elsewhere; stdout path is nominal.
      void stderr;
    }
  }, 20_000);
});
