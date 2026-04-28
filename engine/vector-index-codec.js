/**
 * @file Binary codec for VectorIndex — serialize / deserialize and the
 * cosine helper. Lives next to vector-index.js so the persistence wire
 * format can evolve independently of the index's runtime behavior.
 *
 * Wire format (matches engine/vector-index.js docblock):
 *   [4]  magic 'VIDX' (uint32 BE)
 *   [4]  format version (uint32 LE)
 *   [4]  dims (uint32 LE)
 *   [4]  metric tag length M (uint32 LE)
 *   [M]  metric tag UTF-8
 *   [4]  size — number of populated slots (uint32 LE)
 *   [4]  capacity — total slot count of the buffer (uint32 LE)
 *   [4]  id-pair count P (uint32 LE)
 *   for each pair P:
 *     [4]  id length I (uint32 LE)
 *     [I]  id UTF-8
 *     [4]  slot index (uint32 LE)
 *   [4]  free-slot count F (uint32 LE)
 *   for each free slot F:
 *     [4]  slot index (uint32 LE)
 *   [capacity * dims * 4]  Float32Array buffer (LE)
 *
 * Why custom binary (not JSON of typedArray):
 *   A 10k×1536 Float32Array is 60MB. JSON-stringifying ballooned to 600MB+;
 *   base64 of binary is ~80MB. Decode is also dramatically faster (no
 *   number-string parsing). JSS would not preserve Float32 precision.
 */

// Magic + version sit at the head of every serialized buffer. Reading them
// out of band allows us to refuse to deserialize incompatible payloads with
// a clear error, instead of producing a silently broken index.
export const SERIALIZATION_MAGIC = 0x56494458;          // 'VIDX' as uint32 BE
export const SERIALIZATION_FORMAT_VERSION = 1;

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Why cosine: standard for embedding similarity; magnitude-invariant.
 * Why divide by magnitudes (vs. assuming pre-normalized inputs): correctness
 * on inputs the embedder produced without normalization, at the cost of one
 * extra sqrt per pair. v2 may add a "stored-normalized" flag.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} Similarity in [-1, 1]; 1 means identical direction
 */
export function cosine(a, b) {
  let dot = 0, ma = 0, mb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    ma  += av * av;
    mb  += bv * bv;
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Pack a VectorIndex's state into a binary wire-format Buffer.
 *
 * @param {Object} index - VectorIndex instance (free-fn so we don't
 *   complicate the class with an exported `_state` accessor)
 * @returns {Buffer}
 */
export function packIndex(index) {
  const enc = new TextEncoder();
  const metricBytes = enc.encode(index.metric);
  const idEntries = [];
  let idsByteLen = 0;
  for (const [id, slot] of index._slotOf) {
    const idBytes = enc.encode(id);
    idEntries.push({ idBytes, slot });
    idsByteLen += 4 + idBytes.length + 4;
  }
  const headerBytes = 4 + 4 + 4
                    + 4 + metricBytes.length
                    + 4 + 4
                    + 4 + idsByteLen
                    + 4 + index._freeSlots.length * 4;
  const dataBytes = index._capacity * index.dims * 4;
  const out = Buffer.allocUnsafe(headerBytes + dataBytes);
  let off = 0;
  out.writeUInt32BE(SERIALIZATION_MAGIC, off); off += 4;
  out.writeUInt32LE(SERIALIZATION_FORMAT_VERSION, off); off += 4;
  out.writeUInt32LE(index.dims, off); off += 4;
  out.writeUInt32LE(metricBytes.length, off); off += 4;
  out.set(metricBytes, off); off += metricBytes.length;
  out.writeUInt32LE(index._size, off); off += 4;
  out.writeUInt32LE(index._capacity, off); off += 4;
  out.writeUInt32LE(idEntries.length, off); off += 4;
  for (const { idBytes, slot } of idEntries) {
    out.writeUInt32LE(idBytes.length, off); off += 4;
    out.set(idBytes, off); off += idBytes.length;
    out.writeUInt32LE(slot, off); off += 4;
  }
  out.writeUInt32LE(index._freeSlots.length, off); off += 4;
  for (const slot of index._freeSlots) {
    out.writeUInt32LE(slot, off); off += 4;
  }
  const floatBytes = Buffer.from(
    index._buf.buffer, index._buf.byteOffset, dataBytes
  );
  floatBytes.copy(out, off);
  return out;
}

/**
 * Decode a wire-format buffer into the runtime fields a VectorIndex needs.
 * Returns a POJO of internal state; the VectorIndex constructor stitches it
 * onto a fresh instance.
 *
 * @param {Buffer} buf
 * @returns {Object} { dims, metric, capacity, size, slotOf, idAt, freeSlots, buf }
 * @throws {Error} on magic or version mismatch
 */
export function unpackIndex(buf) {
  let off = 0;
  const magic = buf.readUInt32BE(off); off += 4;
  if (magic !== SERIALIZATION_MAGIC) {
    throw new Error(
      `VectorIndex.deserialize: invalid magic 0x${magic.toString(16)}; ` +
      `expected 'VIDX' (0x${SERIALIZATION_MAGIC.toString(16)}).`
    );
  }
  const version = buf.readUInt32LE(off); off += 4;
  if (version !== SERIALIZATION_FORMAT_VERSION) {
    throw new Error(
      `VectorIndex.deserialize: unsupported format version ${version}; ` +
      `this binary supports version ${SERIALIZATION_FORMAT_VERSION}. ` +
      `Rebuild the index by re-running db.schema with the original embeddings.`
    );
  }
  const dims = buf.readUInt32LE(off); off += 4;
  const metricLen = buf.readUInt32LE(off); off += 4;
  const metric = buf.slice(off, off + metricLen).toString('utf8'); off += metricLen;
  const size = buf.readUInt32LE(off); off += 4;
  const capacity = buf.readUInt32LE(off); off += 4;
  const slotOf = new Map();
  const idAt = new Array(capacity).fill(null);
  const dec = new TextDecoder();
  const pairCount = buf.readUInt32LE(off); off += 4;
  for (let i = 0; i < pairCount; i++) {
    const idLen = buf.readUInt32LE(off); off += 4;
    const id = dec.decode(buf.slice(off, off + idLen)); off += idLen;
    const slot = buf.readUInt32LE(off); off += 4;
    slotOf.set(id, slot);
    idAt[slot] = id;
  }
  const freeSlots = [];
  const freeCount = buf.readUInt32LE(off); off += 4;
  for (let i = 0; i < freeCount; i++) {
    freeSlots.push(buf.readUInt32LE(off));
    off += 4;
  }
  const floatBytes = buf.slice(off, off + capacity * dims * 4);
  const floats = new Float32Array(capacity * dims);
  Buffer.from(floats.buffer).set(floatBytes);
  return { dims, metric, capacity, size, slotOf, idAt, freeSlots, buf: floats };
}
