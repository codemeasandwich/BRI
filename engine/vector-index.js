/**
 * @file Vector index for in-process k-NN search
 *
 * Single-collection vector index. Stores embedding vectors keyed by document
 * $ID and answers top-k queries plus filtered top-k queries.
 *
 * Algorithm choice (v1):
 *   Brute-force linear scan with cosine similarity over Float32Array storage.
 *
 *   Why brute force first: at v1 scale (1k–10k vectors at the spec's
 *   correctness gate), a linear scan over 10k * 1536 floats is well under the
 *   v1 budget and has no algorithmic edge cases — no graph topology to repair
 *   on rollback, no neighbour-link consistency invariants, no parameter
 *   tuning. The pluggable interface below (add/remove/search/searchFiltered/
 *   stats) is identical to what an HNSW or USearch backend would expose, so
 *   the v2 swap is a constructor flag, not an API rewrite.
 *
 * Storage shape:
 *   - One Float32Array of length capacity*dims, packed row-major
 *   - One Map<id, slot> mapping document $ID to row index
 *   - One reverse Array<id|null> mapping row index back to $ID (for hit
 *     retrieval); null entries are tombstones (free slots from prior removes)
 *
 * Why Float32Array (not Array<number>):
 *   - Half the memory of Array<number> at 1536-dim (6 KB/vec → 6 KB/vec for
 *     plain arrays would balloon to 16+ KB each due to object headers).
 *   - Vectorizable arithmetic on hot inner loops via JIT.
 *   - Zero-cost slicing via subarray() for in-place reads.
 *
 * Concurrency:
 *   This module is synchronous and single-threaded. It is intended to live in
 *   the main thread for v1; v2 may move it behind a Worker boundary.
 *   Concurrent writes from multiple await chains are safe at the slot level
 *   because all mutations happen in synchronous JS turns; concurrent search
 *   is read-only against the same buffer.
 *
 * Transactions (deferred):
 *   v1 slice 1 implements a non-transactional index. Tombstone-based txn
 *   support is a follow-up slice. Calls inside a transaction currently apply
 *   to the visible index immediately and a rec/nop boundary will need to
 *   compensate by re-emitting deletes — handled by the wiring middleware in
 *   a later slice, NOT here.
 *
 * @implements UC-V1
 */

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Why cosine: standard for embedding similarity; magnitude-invariant.
 * Why we still divide by magnitudes (vs. assuming pre-normalized inputs):
 *   correctness on inputs the embedder produced without normalization, at
 *   the cost of one extra sqrt per pair. v2 may add a "stored-normalized"
 *   flag to skip the sqrt on the stored side.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} Similarity in [-1, 1]; 1 means identical direction
 */
function cosine(a, b) {
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
 * In-process vector index for one collection.
 *
 * @class VectorIndex
 */
export class VectorIndex {
  /**
   * @param {Object} opts
   * @param {number} opts.dims   - Dimensionality; all vectors must match
   * @param {string} [opts.metric='cosine'] - v1 supports 'cosine' only
   * @param {number} [opts.initialCapacity=64] - Starting slot count
   */
  constructor({ dims, metric = 'cosine', initialCapacity = 64 } = {}) {
    if (typeof dims !== 'number' || dims <= 0) {
      throw new Error(`VectorIndex requires positive 'dims'; got ${dims}`);
    }
    if (metric !== 'cosine') {
      throw new Error(`VectorIndex v1 supports metric='cosine' only; got ${metric}`);
    }
    this.dims = dims;
    this.metric = metric;
    this._capacity = Math.max(8, initialCapacity);
    this._buf = new Float32Array(this._capacity * dims);
    this._idAt = new Array(this._capacity).fill(null);  // slot → id
    this._slotOf = new Map();                           // id → slot
    this._freeSlots = [];                               // recycled removed slots
    this._size = 0;                                     // populated slot count
  }

  /**
   * Insert or replace a vector for a document.
   *
   * Replace semantics: if id is already present, the existing slot is reused
   * and overwritten in place — keeps the slot map stable for any held
   * iterators and avoids fragmentation on update-heavy workloads.
   *
   * @param {string} id - Document $ID
   * @param {ArrayLike<number>} vector - Length must equal this.dims
   * @returns {void}
   * @throws {Error} on dims mismatch
   */
  add(id, vector) {
    if (vector.length !== this.dims) {
      throw new Error(
        `VectorIndex.add: vector dimension mismatch for ${id}: ` +
        `expected ${this.dims}, got ${vector.length}.`
      );
    }
    let slot = this._slotOf.get(id);
    if (slot === undefined) {
      slot = this._freeSlots.length > 0 ? this._freeSlots.pop() : this._size;
      if (slot >= this._capacity) this._grow();
      this._slotOf.set(id, slot);
      this._idAt[slot] = id;
      this._size++;
    }
    const base = slot * this.dims;
    for (let i = 0; i < this.dims; i++) {
      this._buf[base + i] = vector[i];
    }
  }

  /**
   * Remove a vector by document $ID. No-op if id is unknown.
   *
   * Implementation: mark the slot free for recycling. We do NOT zero the
   * underlying Float32Array — search skips the slot via _idAt[slot]===null.
   *
   * @param {string} id
   * @returns {boolean} true if removed, false if id was not present
   */
  remove(id) {
    const slot = this._slotOf.get(id);
    if (slot === undefined) return false;
    this._slotOf.delete(id);
    this._idAt[slot] = null;
    this._freeSlots.push(slot);
    this._size--;
    return true;
  }

  /**
   * Top-k nearest neighbours by cosine similarity.
   *
   * @param {ArrayLike<number>} query - Query vector; must match dims
   * @param {number} k - Maximum results to return
   * @returns {Array<{id:string, score:number}>} sorted score-desc
   * @throws {Error} on dims mismatch
   */
  search(query, k) {
    return this.searchFiltered(query, k, null);
  }

  /**
   * Top-k nearest neighbours filtered by a predicate over the candidate id.
   *
   * Why predicate-during-traversal (not post-filter): the filter must apply
   * BEFORE k truncation so that an under-budget result set isn't padded with
   * ineligible candidates. UC-V1 acceptance criterion 3.
   *
   * @param {ArrayLike<number>} query
   * @param {number} k
   * @param {((id:string)=>boolean)|null} predicate - null disables filtering
   * @returns {Array<{id:string, score:number}>}
   * @throws {Error} on dims mismatch
   */
  searchFiltered(query, k, predicate) {
    if (query.length !== this.dims) {
      throw new Error(
        `VectorIndex.search: query vector dimension mismatch: ` +
        `expected ${this.dims}, got ${query.length}.`
      );
    }
    if (k <= 0 || this._size === 0) return [];

    // Min-heap of size k by score-asc; we evict the smallest to keep top-k.
    // Inline simple selection: at v1 scales the array.sort + slice is fine
    // and keeps the code simple. v2 swaps to a proper heap when warranted.
    const hits = [];
    for (let slot = 0; slot < this._capacity; slot++) {
      const id = this._idAt[slot];
      if (id === null) continue;
      if (predicate && !predicate(id)) continue;
      const base = slot * this.dims;
      const stored = this._buf.subarray(base, base + this.dims);
      const score = cosine(query, stored);
      hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.length > k ? hits.slice(0, k) : hits;
  }

  /**
   * Index statistics for diagnostics.
   *
   * @returns {{count:number, capacity:number, dims:number, metric:string, memoryBytes:number}}
   */
  stats() {
    return {
      count: this._size,
      capacity: this._capacity,
      dims: this.dims,
      metric: this.metric,
      memoryBytes: this._buf.byteLength
    };
  }

  /**
   * Double the underlying buffer when slots are exhausted.
   *
   * Why double: amortizes O(1) per insert across a sequence of inserts.
   * Why we copy with set(): Float32Array.set is the fastest bulk copy
   * available without leaving JS.
   *
   * @private
   */
  _grow() {
    const newCap = this._capacity * 2;
    const newBuf = new Float32Array(newCap * this.dims);
    newBuf.set(this._buf);
    this._buf = newBuf;
    this._idAt.length = newCap;
    for (let i = this._capacity; i < newCap; i++) this._idAt[i] = null;
    this._capacity = newCap;
  }
}

export default VectorIndex;
