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
import { VectorIndex } from '../../engine/vector-index.js';
import {
  cosine, packIndex, unpackIndex,
  SERIALIZATION_FORMAT_VERSION, SERIALIZATION_FORMAT_VERSION_V1
} from '../../engine/vector-index-codec.js';

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
