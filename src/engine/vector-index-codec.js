/**
 * @file Binary codec for VectorIndex — serialize / deserialize and the
 * cosine helper. Lives next to vector-index.js so the persistence wire
 * format can evolve independently of the index's runtime behavior.
 *
 * Wire format (matches engine/vector-index.js docblock):
 *   [4]  magic 'VIDX' (uint32 BE)
 *   [4]  format version (uint32 LE) — 1 = brute-force only; 2 = HNSW
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
 *   --- v2 only (appended after the v1 payload) ---
 *   [4]  HNSW M (uint32 LE)
 *   [4]  HNSW efConstruction (uint32 LE)
 *   [4]  HNSW efSearch (uint32 LE)
 *   [4]  entry-point slot (int32 LE; -1 means empty graph)
 *   [4]  entry level (int32 LE)
 *   [4]  per-slot level table length S (uint32 LE) — equals capacity
 *   [S * 4]  level array (int32 LE per slot, -1 = empty slot)
 *   [4]  neighbour block count B (uint32 LE)
 *   for each B blocks:
 *     [4]  slot (uint32 LE)
 *     [4]  level (uint32 LE)
 *     [4]  neighbour count C (uint32 LE)
 *     [C * 4]  neighbour slots (uint32 LE)
 *
 * Why the v2 graph section is APPENDED (not interleaved):
 *   v1 readers can stop at "end of v1 payload" cleanly when they see
 *   version === 1. v2 readers consume the additional bytes only when
 *   version === 2. A future v3 (e.g. dual native + JS topology) appends
 *   again. Append-only evolution avoids the trap of re-numbering offsets
 *   when shape changes.
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
// Version 2 carries HNSW topology after the v1 payload. Version 1 is still
// recognized for backwards-compatible deserialization (the wrapper rebuilds
// the topology from slot storage). A version > 2 is rejected — readers
// cannot reconstruct an unknown future format.
export const SERIALIZATION_FORMAT_VERSION = 2;
// V1 marker — kept as a named export so the wrapper / recovery path can
// dispatch on `version === 1` without hardcoding the integer.
export const SERIALIZATION_FORMAT_VERSION_V1 = 1;

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
  // Size up the v2 topology section. We write it for every v2 index even
  // when the graph is empty — keeps the reader's branching simpler at
  // unpack time.
  const neighborBlocks = [];
  if (index._neighbors) {
    for (let slot = 0; slot < index._capacity; slot++) {
      const lists = index._neighbors[slot];
      if (!lists) continue;
      for (let L = 0; L < lists.length; L++) {
        const arr = lists[L];
        if (!arr || arr.length === 0) continue;
        neighborBlocks.push({ slot, level: L, arr });
      }
    }
  }
  let topologyBytes = 0;
  topologyBytes += 4 + 4 + 4;                              // M, efC, efS
  topologyBytes += 4 + 4;                                  // entryPoint, entryLevel
  topologyBytes += 4 + index._capacity * 4;                // levels table
  topologyBytes += 4;                                      // neighbour block count
  for (const { arr } of neighborBlocks) {
    topologyBytes += 4 + 4 + 4 + arr.length * 4;
  }

  const headerBytes = 4 + 4 + 4
                    + 4 + metricBytes.length
                    + 4 + 4
                    + 4 + idsByteLen
                    + 4 + index._freeSlots.length * 4;
  const dataBytes = index._capacity * index.dims * 4;
  const out = Buffer.allocUnsafe(headerBytes + dataBytes + topologyBytes);
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
  off += dataBytes;

  // v2 topology section. Default values are emitted even when the graph
  // is empty so v2 readers can take the same code path regardless.
  out.writeUInt32LE(index._hnswM | 0, off); off += 4;
  out.writeUInt32LE(index._hnswEfConstruction | 0, off); off += 4;
  out.writeUInt32LE(index._hnswEfSearch | 0, off); off += 4;
  out.writeInt32LE(index._entryPoint ?? -1, off); off += 4;
  out.writeInt32LE(index._entryLevel ?? -1, off); off += 4;
  out.writeUInt32LE(index._capacity, off); off += 4;
  // Per-slot levels — int32 so -1 (empty slot) round-trips bit-exactly.
  if (index._levels) {
    for (let i = 0; i < index._capacity; i++) {
      out.writeInt32LE(index._levels[i], off); off += 4;
    }
  } else {
    for (let i = 0; i < index._capacity; i++) {
      out.writeInt32LE(-1, off); off += 4;
    }
  }
  out.writeUInt32LE(neighborBlocks.length, off); off += 4;
  for (const { slot, level, arr } of neighborBlocks) {
    out.writeUInt32LE(slot, off); off += 4;
    out.writeUInt32LE(level, off); off += 4;
    out.writeUInt32LE(arr.length, off); off += 4;
    for (let i = 0; i < arr.length; i++) {
      out.writeUInt32LE(arr[i], off); off += 4;
    }
  }
  return out;
}

/**
 * Decode a wire-format buffer into the runtime fields a VectorIndex needs.
 * Returns a POJO of internal state; the VectorIndex constructor stitches it
 * onto a fresh instance.
 *
 * Backwards compatibility:
 *   When `version === 1`, the topology fields are returned as nulls; the
 *   wrapper detects this and triggers a one-shot HNSW topology rebuild
 *   from the populated slot storage.
 *
 * @param {Buffer} buf
 * @returns {Object} { dims, metric, capacity, size, slotOf, idAt,
 *   freeSlots, buf, version, hnsw }
 *   `hnsw` is null for v1 payloads, otherwise
 *   `{ M, efConstruction, efSearch, entryPoint, entryLevel, levels, neighbors }`.
 * @throws {Error} on magic or unsupported-version mismatch
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
  if (version !== SERIALIZATION_FORMAT_VERSION &&
      version !== SERIALIZATION_FORMAT_VERSION_V1) {
    throw new Error(
      `VectorIndex.deserialize: unsupported format version ${version}; ` +
      `this binary supports versions ${SERIALIZATION_FORMAT_VERSION_V1} and ` +
      `${SERIALIZATION_FORMAT_VERSION}. ` +
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
  off += capacity * dims * 4;

  // v1 payload ends here. v2 reads the trailing topology section.
  let hnsw = null;
  if (version === SERIALIZATION_FORMAT_VERSION) {
    const M = buf.readUInt32LE(off); off += 4;
    const efConstruction = buf.readUInt32LE(off); off += 4;
    const efSearch = buf.readUInt32LE(off); off += 4;
    const entryPoint = buf.readInt32LE(off); off += 4;
    const entryLevel = buf.readInt32LE(off); off += 4;
    const levelsLen = buf.readUInt32LE(off); off += 4;
    // levelsLen ought to equal capacity; we trust the writer but bound
    // by capacity so a corrupt header can't drive an oversized alloc.
    const safeLen = Math.min(levelsLen, capacity);
    const levels = new Int32Array(capacity);
    levels.fill(-1);
    for (let i = 0; i < safeLen; i++) {
      levels[i] = buf.readInt32LE(off); off += 4;
    }
    // Skip any trailing entries the writer thought existed past capacity.
    if (levelsLen > safeLen) off += (levelsLen - safeLen) * 4;
    const neighbors = new Array(capacity).fill(null);
    const blockCount = buf.readUInt32LE(off); off += 4;
    for (let b = 0; b < blockCount; b++) {
      const slot = buf.readUInt32LE(off); off += 4;
      const level = buf.readUInt32LE(off); off += 4;
      const cnt = buf.readUInt32LE(off); off += 4;
      const arr = new Int32Array(cnt);
      for (let i = 0; i < cnt; i++) {
        arr[i] = buf.readUInt32LE(off); off += 4;
      }
      // Lazily allocate the per-slot list-of-levels array as we hit
      // entries for that slot. Levels are stored sparsely on disk,
      // so we extend the inner array on demand.
      if (!neighbors[slot]) {
        neighbors[slot] = [];
      }
      while (neighbors[slot].length <= level) {
        neighbors[slot].push(new Int32Array(0));
      }
      neighbors[slot][level] = arr;
    }
    // Backfill any neighbour-list arrays for occupied slots whose levels
    // existed but had zero edges at some level (e.g. a level-1 node with
    // no level-1 neighbours yet — possible for the first few inserts).
    for (let slot = 0; slot < capacity; slot++) {
      if (idAt[slot] === null || levels[slot] < 0) continue;
      if (!neighbors[slot]) neighbors[slot] = [];
      while (neighbors[slot].length <= levels[slot]) {
        neighbors[slot].push(new Int32Array(0));
      }
    }
    hnsw = { M, efConstruction, efSearch, entryPoint, entryLevel, levels, neighbors };
  }
  return { dims, metric, capacity, size, slotOf, idAt, freeSlots, buf: floats, version, hnsw };
}
