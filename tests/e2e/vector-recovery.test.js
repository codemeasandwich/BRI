/**
 * @file Wire-format compatibility tests for the VectorIndex codec.
 *
 * Two acceptance criteria from the v2 HNSW slice:
 *   1) v1-format buffers (no graph topology — written by Bri before the
 *      HNSW upgrade) deserialize cleanly. The wrapper detects the v1
 *      header and triggers a one-shot HNSW rebuild from slot storage.
 *      After the rebuild, search returns the persisted vectors and the
 *      next snapshot is automatically v2.
 *   2) v2 → v2 round-trips preserve the graph topology bit-for-bit:
 *      serialize-deserialize-serialize produces an identical byte
 *      sequence. This pins the format against accidental drift, which
 *      would invalidate every persisted snapshot on disk.
 *
 * Why these tests live in their own file: the acceptance is about
 * codec compatibility across release boundaries, not about runtime
 * search behaviour. Separating them keeps `vector.test.js` focused on
 * UC-V1 and frees this file to add v3 / v4 codec gates as we iterate.
 *
 * @implements UC-V1 §6.2 (HNSW upgrade / wire-format compatibility)
 */
import { jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { openLocalDatabase } from '../helpers/open-database.js';
import { VectorIndex } from '../../src/engine/vector-index.js';
import {
  cosine, packIndex, unpackIndex,
  SERIALIZATION_FORMAT_VERSION, SERIALIZATION_FORMAT_VERSION_V1
} from '../../src/engine/vector-index-codec.js';
import JSS from '../../src/utils/jss/index.js';

const DIMS = 8;

/**
 * Deterministic embedding harness — same shape as makeVec in vector.test.js.
 * Local to this file so changes here don't ripple.
 */
function makeVec(seed, dims = DIMS) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
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

/**
 * Synthesize a v1-format buffer from a populated VectorIndex.
 *
 * Why we don't keep a static fixture: the v1 codec lives in source
 * history, not in the current tree. Recreating the v1 layout from the
 * current packIndex output is structurally simpler — write the v2
 * payload, then truncate the appended topology section and overwrite
 * the version field.
 *
 * Wire format (mirrors vector-index-codec.js):
 *   [4]  magic 'VIDX' (uint32 BE)
 *   [4]  format version (uint32 LE) — set to 1 for v1
 *   [4]  dims (uint32 LE)
 *   [4]  metric tag length M
 *   [M]  metric tag UTF-8
 *   [4]  size, [4] capacity
 *   [4]  pair count + pairs
 *   [4]  free-slot count + free slots
 *   [capacity * dims * 4]  Float32Array buffer
 *
 * @param {VectorIndex} idx
 * @returns {Buffer} v1-format buffer (no topology section)
 */
function asV1Buffer(idx) {
  const v2 = packIndex(idx);
  // Walk the header to find where the v1 payload ends — exactly at the
  // end of the float buffer.
  let off = 4 + 4;                                            // magic + version
  off += 4;                                                   // dims
  const metricLen = v2.readUInt32LE(off); off += 4;
  off += metricLen;
  off += 4 + 4;                                               // size + capacity
  const pairCount = v2.readUInt32LE(off); off += 4;
  for (let i = 0; i < pairCount; i++) {
    const idLen = v2.readUInt32LE(off); off += 4 + idLen + 4;
  }
  const freeCount = v2.readUInt32LE(off); off += 4;
  off += freeCount * 4;
  off += idx._capacity * idx.dims * 4;
  const v1 = Buffer.from(v2.slice(0, off));
  v1.writeUInt32LE(1, 4);                                     // version → 1
  return v1;
}

describe('VectorIndex codec — v1 → v2 backwards compatibility', () => {
  test('v1 buffer deserializes and rebuilds a working HNSW graph', () => {
    // Build a populated index and flatten it to v1.
    const src = new VectorIndex({ dims: DIMS, seed: 1 });
    const N = 30;
    const vecs = [];
    for (let i = 0; i < N; i++) {
      const v = makeVec(`v1-${i}`);
      vecs.push({ id: `id_${i}`, v });
      src.add(`id_${i}`, v);
    }
    const v1Buf = asV1Buffer(src);
    // Sanity: the simulated v1 buffer carries the v1 version marker.
    expect(unpackIndex(v1Buf).version).toBe(SERIALIZATION_FORMAT_VERSION_V1);
    // Deserialize — wrapper logs the rebuild line; we don't assert on
    // the log to keep the test environment-agnostic, but the
    // entry-point should be set after the call.
    const idx = VectorIndex.deserialize(v1Buf);
    expect(idx._size).toBe(N);
    expect(idx._entryPoint).toBeGreaterThanOrEqual(0);
    expect(idx._entryLevel).toBeGreaterThanOrEqual(0);
    // Search must find what we inserted — identical query vector should
    // produce the original ID at the top.
    for (let i = 0; i < 5; i++) {
      const probe = vecs[i * 5];
      const hits = idx.search(probe.v, 1);
      expect(hits[0].id).toBe(probe.id);
      expect(hits[0].score).toBeGreaterThan(0.9999);
    }
  });

  test('post-rebuild serialize emits v2 (not v1)', () => {
    const src = new VectorIndex({ dims: DIMS, seed: 2 });
    for (let i = 0; i < 10; i++) src.add(`id_${i}`, makeVec(`r-${i}`));
    const v1Buf = asV1Buffer(src);
    const idx = VectorIndex.deserialize(v1Buf);
    const reSerialized = idx.serialize();
    // The first 4 bytes are the magic; bytes 4..7 are version LE.
    expect(reSerialized.readUInt32LE(4)).toBe(SERIALIZATION_FORMAT_VERSION);
  });

  test('v2 → v2 roundtrip is bit-identical', () => {
    const src = new VectorIndex({ dims: DIMS, seed: 42, initialCapacity: 50 });
    for (let i = 0; i < 50; i++) src.add(`id_${i}`, makeVec(`rt-${i}`));
    const a = src.serialize();
    const restored = VectorIndex.deserialize(a);
    const b = restored.serialize();
    // Topology, slot storage, free-list, and float buffer must all
    // round-trip without drift. Buffer.compare returns 0 on equality.
    expect(a.length).toBe(b.length);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  test('v2 → v2 roundtrip preserves search results', () => {
    const src = new VectorIndex({ dims: DIMS, seed: 99, initialCapacity: 50 });
    const vecs = [];
    for (let i = 0; i < 50; i++) {
      const v = makeVec(`rs-${i}`);
      vecs.push({ id: `id_${i}`, v });
      src.add(`id_${i}`, v);
    }
    const restored = VectorIndex.deserialize(src.serialize());
    // Same query against both indexes must produce identical results
    // (same IDs, same scores). HNSW topology is deterministic given
    // the seed, so this is a strict equality assertion.
    const q = makeVec('roundtrip-query');
    const before = src.search(q, 10);
    const after = restored.search(q, 10);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].id).toBe(before[i].id);
      expect(after[i].score).toBeCloseTo(before[i].score, 6);
    }
  });

  test('unsupported future version is rejected with a diagnostic error', () => {
    const src = new VectorIndex({ dims: DIMS });
    src.add('a', makeVec('a'));
    const buf = src.serialize();
    // Stamp version=99 — a future format we don't know how to read.
    buf.writeUInt32LE(99, 4);
    expect(() => VectorIndex.deserialize(buf))
      .toThrow(/unsupported format version 99/);
  });

  test('cosine returns 0 when either vector has zero magnitude', () => {
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(cosine([0, 0], [0, 0])).toBe(0);
  });

  test('unpackIndex throws on invalid VIDX magic', () => {
    const badMagic = Buffer.alloc(32);
    badMagic.writeUInt32BE(0, 0);
    expect(() => unpackIndex(badMagic)).toThrow(/invalid magic/);
  });

  test('unpackIndex restores free-slot bookkeeping when serialization lists freed indexes', () => {
    const idx = new VectorIndex({ dims: DIMS, initialCapacity: 16 });
    idx.add('keep', makeVec('keep'));
    idx.add('drop', makeVec('drop'));
    idx.remove('drop');
    const u = unpackIndex(idx.serialize());
    expect(u.freeSlots.length).toBeGreaterThan(0);
  });

  test('packIndex works when topology bucket is transiently missing', () => {
    const idx = new VectorIndex({ dims: DIMS, initialCapacity: 16 });
    idx.add('solo', makeVec('solo'));
    delete idx._neighbors;
    expect(() => packIndex(idx)).not.toThrow();
  });

  test('packIndex writes fallback entry sentinel when entry fields are omitted', () => {
    const idx = new VectorIndex({ dims: DIMS, initialCapacity: 8 });
    delete idx._entryPoint;
    delete idx._entryLevel;
    delete idx._levels;
    const buf = packIndex(idx);
    const u = unpackIndex(buf);
    expect(u.hnsw.entryPoint).toBe(-1);
    expect(u.hnsw.entryLevel).toBe(-1);
  });

  test('unpackIndex skips oversized level tails when levelsLen corrupts beyond capacity', () => {
    const idx = new VectorIndex({ dims: 2, initialCapacity: 8 });
    const base = Buffer.from(idx.serialize());
    /** Walk payload to locate `levelsLen` in the v2 tail (capacity follows entryLevel). */
    let o = 4 + 4 + 4;
    o += 4 + base.readUInt32LE(o);
    o += 4 + 4;
    let pc = base.readUInt32LE(o); o += 4;
    while (pc-- > 0) {
      const il = base.readUInt32LE(o); o += 4 + il + 4;
    }
    const fc = base.readUInt32LE(o); o += 4;
    o += fc * 4;
    o += idx._capacity * idx.dims * 4;
    o += 4 + 4 + 4 + 4 + 4;
    const patched = Buffer.alloc(base.length + 4000);
    base.copy(patched);
    patched.writeUInt32LE(idx._capacity + 50, o);
    expect(() => unpackIndex(patched)).not.toThrow();
  });

  test('v1 rebuild handles the empty-index edge case', () => {
    // An empty index can still be serialized and round-tripped; the
    // rebuild path must short-circuit cleanly when there are no slots
    // to re-insert.
    const empty = new VectorIndex({ dims: DIMS });
    const v1 = asV1Buffer(empty);
    const idx = VectorIndex.deserialize(v1);
    expect(idx._size).toBe(0);
    expect(idx._entryPoint).toBe(-1);
    expect(idx.search(makeVec('q'), 5)).toEqual([]);
  });
});

describe('VectorIndex codec — full DB lifecycle v1 → v2 upgrade', () => {
  /**
   * End-to-end variant of the codec compatibility tests above. Writes a
   * real snapshot.jss file to disk with a v1-format vector buffer
   * embedded inside, boots openLocalDatabase against that data dir, and asserts
   * the search path returns the persisted vectors. This exercises:
   *   - SnapshotManager.loadLatest reading the file
   *   - inhouse-recovery.loadVectorState base64-decoding + dispatching
   *   - VectorIndex.deserialize routing v1 → rebuildTopology
   *   - schema-registry.declare reusing the persisted index instance
   *   - QueryBuilder.near + searchFiltered hitting the rebuilt graph
   * Without this gate, a regression in any of those steps would only
   * surface in production — synthetic-buffer tests above don't exercise
   * SnapshotManager or the recovery dispatch.
   */
  const E2E_DIR = './test-data-vector-v1-upgrade';
  const E2E_DIMS = 8;

  /**
   * Build a populated VectorIndex, downgrade its serialized buffer to
   * v1 (no topology section), and return the v1 buffer.
   */
  function buildV1Buffer(items) {
    const src = new VectorIndex({ dims: E2E_DIMS, seed: 5 });
    for (const { id, vec } of items) src.add(id, vec);
    return asV1Buffer(src);
  }

  /**
   * Synthesize a fresh snapshot.jss file from scratch with a v1-format
   * vector index buffer for one collection. We bypass createSnapshot
   * because that always emits v2; we want to model an old database
   * directory that pre-dates the HNSW upgrade.
   */
  async function writeV1Snapshot(dir, collection, schema, ids, vecs, docs) {
    await fs.mkdir(dir, { recursive: true });
    const items = ids.map((id, i) => ({ id, vec: vecs[i] }));
    const v1Buf = buildV1Buffer(items);
    // Use the same JSS writer the production SnapshotManager uses.
    // Format: snapshot v3 carries vectorIndices + vectorSchemas.
    // Documents map: every id maps to a doc body containing the embedding
    // and any extra metadata so middleware/lookup can resolve by $ID.
    const documents = {};
    for (let i = 0; i < ids.length; i++) {
      documents[ids[i]] = docs[i];
    }
    const collections = {};
    collections[collection] = ids.slice();
    const state = {
      version: 3,
      walLine: 0,
      documents,
      collections,
      vectorIndices: { [collection]: v1Buf.toString('base64') },
      vectorSchemas: { [collection]: { field: 'embedding', dims: E2E_DIMS, metric: 'cosine' } }
    };
    const snapshotPath = path.join(dir, 'snapshot.jss');
    await fs.writeFile(snapshotPath, JSS.stringify(state), 'utf8');
  }

  beforeEach(async () => {
    await fs.rm(E2E_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await fs.rm(E2E_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('boot reads v1 snapshot and search returns persisted vectors', async () => {
    // Construct a 6-doc dataset and write it as a v1 snapshot file.
    const N = 6;
    const ids = [];
    const vecs = [];
    const docs = [];
    // Collection prefix is type2Short('memoryArtifact') = 'MEAR'.
    // We must use IDs that match Bri's id format so the prefix→collection
    // routing works in middleware lookup paths.
    for (let i = 0; i < N; i++) {
      const id = `MEAR_v1up${String(i).padStart(2, '0')}a`;
      const vec = makeVec(`v1upgrade-${i}`);
      ids.push(id);
      vecs.push(vec);
      docs.push({ $ID: id, type: 'fact', embedding: vec });
    }
    await writeV1Snapshot(E2E_DIR, 'memoryArtifact', { field: 'embedding', dims: E2E_DIMS },
      ids, vecs, docs);

    // Boot the DB; the recovery path will read the v1 buffer, log the
    // rebuild, and reconstruct the HNSW topology before db.schema runs.
    const db = await openLocalDatabase({ storeConfig: { dataDir: E2E_DIR, maxMemoryMB: 64 } });
    db.schema('memoryArtifact', {
      type:      { type: String, required: true },
      embedding: { type: 'vector', dims: E2E_DIMS, required: false }
    });

    // Search for each persisted vector — must return its own ID at top.
    for (let i = 0; i < N; i++) {
      const hits = await db.get.memoryArtifactS.near(vecs[i], 1).toArray();
      expect(hits[0].$ID).toBe(ids[i]);
      expect(hits[0].$cosine).toBeGreaterThan(0.9999);
    }

    // Verify the next snapshot is v2 (the codec emits the current format).
    await db._store.createSnapshot();
    await db.disconnect();
    // Read the snapshot.jss back and verify the embedded vector buffer
    // version field is now 2 (not 1).
    const snapText = await fs.readFile(path.join(E2E_DIR, 'snapshot.jss'), 'utf8');
    const snap = JSS.parse(snapText);
    const upgraded = Buffer.from(snap.vectorIndices.memoryArtifact, 'base64');
    expect(upgraded.readUInt32LE(4)).toBe(SERIALIZATION_FORMAT_VERSION);
  });
});
