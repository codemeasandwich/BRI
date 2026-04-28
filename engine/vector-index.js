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
 * Persistence:
 *   serialize() / static deserialize() pack the index into a compact binary
 *   wire format (see SERIALIZATION_FORMAT_VERSION below). Snapshots embed the
 *   buffer base64-encoded inside the snapshot JSON; the existing AES-256-GCM
 *   at-rest encryption applied to the snapshot covers vector data without
 *   any extra path. Wire format is independent of in-process JS state, so
 *   producer and consumer may be different processes / Node versions.
 *
 * @implements UC-V1
 */

import { cosine, packIndex, unpackIndex } from './vector-index-codec.js';

/**
 * In-process vector index for one collection.
 *
 * Transaction model (UC-V4):
 *   Inside an open transaction, vector ops are not applied to the committed
 *   storage above. They go into _pending, a Map<txnId, Array<{op,id,vec}>>.
 *   - searchInTxn(query, k, txnId) merges the committed search with the
 *     pending log entries for that txnId, so the writer sees its own
 *     buffered changes immediately while outside-txn callers don't.
 *   - commit(txnId) flushes the pending ops to the committed index.
 *   - rollback(txnId) discards the pending bucket entirely.
 *   - popStaged(txnId, id) drops the most recent pending op for that id.
 *
 *   Why deferred linking (instead of tombstone-marking applied entries):
 *   the committed index never carries half-applied state, so nop is O(1)
 *   (drop the bucket) and crash recovery is automatically pre-txn (the
 *   committed buffer was never touched). Spec §7.1 picks this trade-off
 *   for v1 — slightly larger working set during long transactions in
 *   exchange for trivial recovery semantics.
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
    // Per-txn deferred-linking buffer: txnId → array of {op, id, vec}.
    // 'op' is 'add' or 'remove'. Pending ops never touch _buf / _slotOf
    // until commit(txnId) flushes them.
    this._pending = new Map();
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
   * Stage an add inside a transaction.
   *
   * Validates dims up front so an oversize/undersize vector fails the same
   * way as the non-txn add() path; the surrounding middleware translates
   * this into a write-time validation error visible to the caller.
   *
   * @param {string} txnId - Active transaction id
   * @param {string} id - Document $ID
   * @param {ArrayLike<number>} vector
   * @throws {Error} on dims mismatch
   */
  addStaged(txnId, id, vector) {
    if (vector.length !== this.dims) {
      throw new Error(
        `VectorIndex.addStaged: vector dimension mismatch for ${id}: ` +
        `expected ${this.dims}, got ${vector.length}.`
      );
    }
    if (!this._pending.has(txnId)) this._pending.set(txnId, []);
    // Defensive copy: caller's array may be mutated after staging. Use
    // Float32Array to keep the storage representation consistent with the
    // committed buffer.
    const copy = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) copy[i] = vector[i];
    this._pending.get(txnId).push({ op: 'add', id, vec: copy });
  }

  /**
   * Stage a remove inside a transaction.
   *
   * Symmetric to addStaged. The pending log records the removal; commit
   * applies it to the committed index, rollback drops it.
   *
   * @param {string} txnId
   * @param {string} id - Document $ID being removed
   */
  removeStaged(txnId, id) {
    if (!this._pending.has(txnId)) this._pending.set(txnId, []);
    this._pending.get(txnId).push({ op: 'remove', id, vec: null });
  }

  /**
   * Flush all pending ops for txnId to the committed index, then drop the
   * pending bucket. Idempotent — calling commit on an unknown txnId is a
   * no-op so callers don't need to track which collections had staged ops.
   *
   * @param {string} txnId
   */
  commit(txnId) {
    const ops = this._pending.get(txnId);
    if (!ops) return;
    for (const { op, id, vec } of ops) {
      if (op === 'add') this.add(id, vec);
      else if (op === 'remove') this.remove(id);
    }
    this._pending.delete(txnId);
  }

  /**
   * Discard all pending ops for txnId without touching the committed index.
   * Idempotent.
   *
   * @param {string} txnId
   */
  rollback(txnId) {
    this._pending.delete(txnId);
  }

  /**
   * Drop the most recent pending op for the given $ID within txnId. Used by
   * the proxy's pop() handler when the popped action targeted a vector-
   * bearing doc.
   *
   * @param {string} txnId
   * @param {string} id - Document $ID whose last staged op should be removed
   * @returns {boolean} true if a pending op was popped, false otherwise
   */
  popStaged(txnId, id) {
    const ops = this._pending.get(txnId);
    if (!ops || ops.length === 0) return false;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].id === id) {
        ops.splice(i, 1);
        if (ops.length === 0) this._pending.delete(txnId);
        return true;
      }
    }
    return false;
  }

  /**
   * Search merging the committed index with the pending log for one txn.
   *
   * Algorithm:
   *   1. Run committed search (existing path).
   *   2. Score every pending add for this txn against the query, replacing
   *      committed results with the same id (later-staged wins).
   *   3. Drop committed results whose id appears as a pending 'remove'.
   *   4. Re-sort and truncate to k.
   *
   * Why merge (instead of materialize the pending log into a temporary
   * shadow index): pending logs are bounded by the txn's lifetime, which is
   * orders of magnitude smaller than the committed index. Linear scan over
   * the pending log is cheaper than allocating + populating a parallel
   * index per query.
   *
   * @param {ArrayLike<number>} query
   * @param {number} k
   * @param {string} txnId
   * @param {((id:string)=>boolean)|null} predicate - Optional caller filter,
   *   applied to both committed and pending candidates
   * @returns {Array<{id:string, score:number}>}
   */
  searchInTxn(query, k, txnId, predicate = null) {
    if (query.length !== this.dims) {
      throw new Error(
        `VectorIndex.searchInTxn: query vector dimension mismatch: ` +
        `expected ${this.dims}, got ${query.length}.`
      );
    }
    const ops = this._pending.get(txnId) || [];
    // Index 'remove' targets — drop these from committed results.
    const stagedRemoves = new Set();
    // Latest-staged-vector-by-id, applied as additions during merge.
    const stagedAdds = new Map();
    for (const { op, id, vec } of ops) {
      if (op === 'remove') {
        stagedRemoves.add(id);
        stagedAdds.delete(id);
      } else if (op === 'add') {
        stagedRemoves.delete(id);
        stagedAdds.set(id, vec);
      }
    }
    // Run a wider committed search so that drops/replaces don't truncate
    // genuine hits below k. Heuristic: 2*k + #pendingAdds is a safe upper
    // bound for v1 scale; v2 may need a smarter "iterate-until-k" approach.
    const wideK = k + stagedAdds.size + stagedRemoves.size;
    const committed = this.searchFiltered(query, wideK,
      (id) => (!predicate || predicate(id)) && !stagedRemoves.has(id));
    const merged = committed.slice();
    // Score and merge pending adds.
    for (const [id, vec] of stagedAdds) {
      if (predicate && !predicate(id)) continue;
      const score = cosine(query, vec);
      // Replace any committed entry for the same id (this id was staged).
      const existingIdx = merged.findIndex(h => h.id === id);
      if (existingIdx >= 0) merged[existingIdx] = { id, score };
      else merged.push({ id, score });
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.length > k ? merged.slice(0, k) : merged;
  }

  /**
   * Pack into the binary wire format. Delegates to vector-index-codec
   * (free function over the index's internals) so the format can evolve
   * independently of the index's runtime behavior.
   * @returns {Buffer}
   */
  serialize() {
    return packIndex(this);
  }

  /**
   * Reconstruct a VectorIndex from a buffer produced by serialize().
   * @param {Buffer} buf
   * @returns {VectorIndex}
   * @throws {Error} on magic or version mismatch
   */
  static deserialize(buf) {
    const state = unpackIndex(buf);
    const idx = new VectorIndex({
      dims: state.dims,
      metric: state.metric,
      initialCapacity: Math.max(8, state.capacity)
    });
    idx._capacity = state.capacity;
    idx._buf = state.buf;
    idx._idAt = state.idAt;
    idx._slotOf = state.slotOf;
    idx._freeSlots = state.freeSlots;
    idx._size = state.size;
    return idx;
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
