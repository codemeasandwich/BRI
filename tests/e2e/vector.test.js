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
import fs from 'fs/promises';

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
    // A 4-dim vector when schema declared 8 dims must not silently store.
    // The behavior contract: schema validator returns a descriptive error.
    const validate = (await import('../../utils/schema/index.js')).default;
    const schema = { embedding: { type: 'vector', dims: DIMS } };
    const err = validate(schema, { embedding: [1, 2, 3, 4] });
    expect(err).not.toBeNull();
    expect(err).toMatch(/dim/i);
  });

  test('non-finite values in embedding are rejected', async () => {
    const validate = (await import('../../utils/schema/index.js')).default;
    const schema = { embedding: { type: 'vector', dims: 3 } };
    expect(validate(schema, { embedding: [1, NaN, 3] })).not.toBeNull();
    expect(validate(schema, { embedding: [1, Infinity, 3] })).not.toBeNull();
    expect(validate(schema, { embedding: [1, 2, 3] })).toBeNull();
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
});
