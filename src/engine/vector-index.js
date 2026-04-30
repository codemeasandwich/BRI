/**
 * @file Vector index for in-process k-NN search
 *
 * Single-collection vector index. Stores embedding vectors keyed by document
 * $ID and answers top-k queries plus filtered top-k queries.
 *
 * Algorithm choice (v2):
 *   Pure-JS HNSW (Hierarchical Navigable Small World) graph. The wrapper
 *   in this file owns slot storage; HNSW topology + insert/search/select-
 *   neighbours live in vector-index-hnsw.js, the per-txn buffer + merge
 *   live in vector-index-txn.js, the wire-format codec lives in
 *   vector-index-codec.js. Why split: spec §3.1 caps source files at
 *   200 NCLOC; each helper module has one responsibility and one set of
 *   reviewers.
 *
 *   Why HNSW: spec §6.2 v2 latency budgets (UC-V1 <50ms p95 over 100k)
 *   require sub-linear search. HNSW gives logarithmic average-case
 *   complexity with strong recall (≥99% at default parameters) and
 *   pure-JS feasibility (no native binding required by default).
 *
 *   At fixture-scale (≤100 nodes), efSearch=max(50, k) makes the wide
 *   level-0 search visit the full candidate frontier — exact recall.
 *
 * Storage shape:
 *   - Float32Array of length capacity*dims, packed row-major
 *   - Map<id, slot> + Array<id|null> reverse map (null = tombstone)
 *   - Topology arrays installed by ensureTopology in vector-index-hnsw.js
 *
 * Concurrency / transactions / persistence: see the helper modules and
 * the file header comments there. Public surface is preserved across
 * v1→v2 except for the additive `opts` parameter on search methods.
 *
 * @implements UC-V1 §6.2
 */

import { cosine, packIndex, unpackIndex } from './vector-index-codec.js';
import { makeRng } from './vector-index-rng.js';
import { insertNode, searchHNSW } from './vector-index-hnsw.js';
import { ensureTopology, dropNode, rebuildTopology } from './vector-index-hnsw-state.js';
import {
  stageAdd, stageRemove, commitTxn, rollbackTxn, popStagedOp, searchInTxnMerged
} from './vector-index-txn.js';
import {
  BriValidationError, BriQueryError, BriSchemaError,
  VECTOR_DIMS_MISMATCH, VECTOR_QUERY_DIMS_MISMATCH
} from './errors.js';

// HNSW parameter defaults — chosen per spec §3.1 / §6.2 to match the
// canonical Malkov & Yashunin recommendations and the v2 latency budgets.
// M=16: balances out-degree (memory) against recall.
// efConstruction=200: insertion-time candidate frontier (denser graph,
//   slower insert at higher values; 200 is the standard build-once preset).
// efSearch=50: query-time frontier (better recall, slower at higher values).
//   The wrapper bumps it to max(efSearch, k) so callers asking for more
//   results than the default frontier always get them.
const HNSW_M_DEFAULT = 16;
const HNSW_EF_CONSTRUCTION_DEFAULT = 200;
const HNSW_EF_SEARCH_DEFAULT = 50;

/**
 * In-process vector index for one collection.
 *
 * Transaction model (UC-V4) preserved from v1: per-txn pending bucket sits
 * ABOVE the topology; commit/rollback/searchInTxn delegate to the helper
 * functions in vector-index-txn.js.
 *
 * @class VectorIndex
 */
export class VectorIndex {
  /**
   * @param {Object} opts
   * @param {number} opts.dims   - Dimensionality; all vectors must match
   * @param {string} [opts.metric='cosine'] - v2 supports 'cosine' only
   * @param {number} [opts.initialCapacity=64] - Starting slot count
   * @param {number} [opts.M=16] - HNSW max neighbours per upper level
   * @param {number} [opts.efConstruction=200] - Insertion-time candidate ef
   * @param {number} [opts.efSearch=50] - Query-time candidate ef default
   * @param {number|null} [opts.seed=null] - Optional RNG seed for level-pick
   *   determinism (tests). Falls through to BRI_VECTOR_RNG_SEED env then
   *   to non-deterministic Math.random.
   */
  constructor({
    dims, metric = 'cosine', initialCapacity = 64,
    M = HNSW_M_DEFAULT,
    efConstruction = HNSW_EF_CONSTRUCTION_DEFAULT,
    efSearch = HNSW_EF_SEARCH_DEFAULT,
    seed = null
  } = {}) {
    if (typeof dims !== 'number' || dims <= 0) {
      throw new BriSchemaError({
        code: 'VECTOR_DIMS_INVALID',
        message: `VectorIndex requires positive 'dims'; got ${JSON.stringify(dims)}. Schema's 'vector' field must declare { dims: <positive integer> }.`,
        details: { dims }
      });
    }
    if (metric !== 'cosine') {
      throw new BriSchemaError({
        code: 'VECTOR_METRIC_UNSUPPORTED',
        message: `VectorIndex v1 supports metric='cosine' only; got '${metric}'. Use { metric: 'cosine' } in the schema or omit the field — cosine is the default.`,
        details: { metric }
      });
    }
    this.dims = dims;
    this.metric = metric;
    this._capacity = Math.max(8, initialCapacity);
    this._buf = new Float32Array(this._capacity * dims);
    this._idAt = new Array(this._capacity).fill(null);
    this._slotOf = new Map();
    this._freeSlots = [];
    this._size = 0;
    this._pending = new Map();
    this._hnswM = M;
    this._hnswEfConstruction = efConstruction;
    this._hnswEfSearch = efSearch;
    // Resolve the RNG seed once. Env-var support pins determinism without
    // per-call plumbing — set BRI_VECTOR_RNG_SEED for reproducibility.
    const envSeed = process.env.BRI_VECTOR_RNG_SEED;
    const effectiveSeed = seed != null
      ? seed
      : (envSeed !== undefined ? Number.parseInt(envSeed, 10) : null);
    this._hnswRng = makeRng(effectiveSeed);
    ensureTopology(this);
  }

  /**
   * Insert or replace a vector for a document.
   *
   * Replace semantics: existing slot is overwritten in place; the old
   * graph node is dropped and a new one inserted because the vector's
   * direction may have moved enough that its neighbour set should change.
   *
   * @param {string} id
   * @param {ArrayLike<number>} vector
   * @throws {BriValidationError} VECTOR_DIMS_MISMATCH on dims mismatch
   */
  add(id, vector) {
    if (vector.length !== this.dims) {
      throw new BriValidationError({
        code: VECTOR_DIMS_MISMATCH,
        message: `VectorIndex.add: vector dimension mismatch for '${id}'. Schema declares ${this.dims}, value has ${vector.length}. Re-embed with the configured model or check the schema dims declaration.`,
        details: { id, expected: this.dims, got: vector.length }
      });
    }
    let slot = this._slotOf.get(id);
    if (slot !== undefined) {
      dropNode(this, slot);
    } else {
      slot = this._freeSlots.length > 0 ? this._freeSlots.pop() : this._size;
      if (slot >= this._capacity) this._grow();
      this._slotOf.set(id, slot);
      this._idAt[slot] = id;
      this._size++;
    }
    const base = slot * this.dims;
    for (let i = 0; i < this.dims; i++) this._buf[base + i] = vector[i];
    insertNode(this, slot);
  }

  /**
   * Remove a vector by document $ID. Lazy-delete: tombstone the slot
   * and drop the node from the topology. Other nodes' links to this
   * slot are skipped at search time via _idAt[n] === null.
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
    dropNode(this, slot);
    return true;
  }

  /**
   * Top-k nearest neighbours by cosine similarity.
   * @param {ArrayLike<number>} query
   * @param {number} k
   * @param {Object} [opts]
   * @param {number} [opts.efSearch] - Override the default efSearch
   * @returns {Array<{id:string, score:number}>}
   */
  search(query, k, opts) {
    return this.searchFiltered(query, k, null, opts);
  }

  /**
   * Top-k nearest neighbours filtered by a predicate over the candidate id.
   *
   * Filter applies DURING graph expansion (UC-V1 acceptance criterion 3) —
   * see searchLayer in vector-index-hnsw.js. A rejected candidate can still
   * BRIDGE the walker to other accepting nodes, so we never disconnect the
   * result set from the part of the graph it lives in.
   *
   * @param {ArrayLike<number>} query
   * @param {number} k
   * @param {((id:string)=>boolean)|null} predicate
   * @param {Object} [opts]
   * @param {number} [opts.efSearch]
   * @returns {Array<{id:string, score:number}>}
   * @throws {BriQueryError} VECTOR_QUERY_DIMS_MISMATCH on dims mismatch
   */
  searchFiltered(query, k, predicate, opts) {
    if (query.length !== this.dims) {
      throw new BriQueryError({
        code: VECTOR_QUERY_DIMS_MISMATCH,
        message: `VectorIndex.search: query vector dims ${query.length} do not match collection's vector field dims ${this.dims}. Re-embed the query with the same model the collection was indexed with.`,
        details: { expected: this.dims, got: query.length }
      });
    }
    if (k <= 0 || this._size === 0) return [];
    const ef = opts && typeof opts.efSearch === 'number' ? opts.efSearch : undefined;
    return searchHNSW(this, query, k, predicate, ef);
  }

  /**
   * Index statistics for diagnostics. Additive shape extension over v1:
   * adds entryLevel / M / efConstruction / efSearch so operators and
   * tests can introspect the active configuration.
   * @returns {Object}
   */
  stats() {
    return {
      count: this._size,
      capacity: this._capacity,
      dims: this.dims,
      metric: this.metric,
      memoryBytes: this._buf.byteLength,
      entryLevel: this._entryLevel,
      M: this._hnswM,
      efConstruction: this._hnswEfConstruction,
      efSearch: this._hnswEfSearch
    };
  }

  // Transaction surface — thin wrappers over vector-index-txn.js. Public
  // method names + signatures are preserved verbatim from v1; the helper
  // module owns the actual bookkeeping. Why wrap (not export raw): the
  // class form is part of the public API consumed by middleware and the
  // schema registry. Switching to free functions would break callers.

  /**
   * Stage an add inside a transaction.
   * @param {string} txnId - Active transaction id
   * @param {string} id - Document $ID
   * @param {ArrayLike<number>} vector
   */
  addStaged(txnId, id, vector) { stageAdd(this, txnId, id, vector); }

  /**
   * Stage a remove inside a transaction.
   * @param {string} txnId
   * @param {string} id - Document $ID being removed
   */
  removeStaged(txnId, id) { stageRemove(this, txnId, id); }

  /**
   * Flush all staged ops for txnId to the committed index. Idempotent.
   * @param {string} txnId
   */
  commit(txnId) {
    commitTxn(this, txnId,
      (id, vec) => this.add(id, vec),
      (id) => this.remove(id));
  }

  /**
   * Discard all pending ops for txnId. Idempotent.
   * @param {string} txnId
   */
  rollback(txnId) { rollbackTxn(this, txnId); }

  /**
   * Drop the most recent pending op for the given $ID within txnId.
   * @param {string} txnId
   * @param {string} id - Document $ID whose last staged op should be removed
   * @returns {boolean} true if an op was popped, false otherwise
   */
  popStaged(txnId, id) { return popStagedOp(this, txnId, id); }

  /**
   * Search merging the committed index with the pending log for one txn.
   * @param {ArrayLike<number>} query
   * @param {number} k
   * @param {string} txnId
   * @param {((id:string)=>boolean)|null} predicate
   * @param {Object} [opts] - efSearch override forwarded to searchFiltered
   * @returns {Array<{id:string, score:number}>}
   */
  searchInTxn(query, k, txnId, predicate = null, opts) {
    if (query.length !== this.dims) {
      throw new BriQueryError({
        code: VECTOR_QUERY_DIMS_MISMATCH,
        message: `VectorIndex.searchInTxn: query vector dims ${query.length} do not match collection's vector field dims ${this.dims}. Re-embed the query with the same model the collection was indexed with.`,
        details: { expected: this.dims, got: query.length }
      });
    }
    return searchInTxnMerged(this, query, k, txnId, predicate, opts,
      (q, kArg, pred, optsArg) => this.searchFiltered(q, kArg, pred, optsArg));
  }

  /**
   * Pack into the binary wire format.
   * @returns {Buffer} v2-format buffer (see vector-index-codec.js)
   */
  serialize() { return packIndex(this); }

  /**
   * Reconstruct a VectorIndex from a buffer produced by serialize().
   * v1 buffers (no topology) trigger a one-shot HNSW rebuild via
   * rebuildTopology; v2 buffers install the persisted topology directly.
   * @param {Buffer} buf
   * @returns {VectorIndex}
   * @throws {Error} on magic / unsupported-version mismatch
   */
  static deserialize(buf) {
    const state = unpackIndex(buf);
    const opts = { dims: state.dims, metric: state.metric,
      initialCapacity: Math.max(8, state.capacity) };
    if (state.hnsw) {
      opts.M = state.hnsw.M;
      opts.efConstruction = state.hnsw.efConstruction;
      opts.efSearch = state.hnsw.efSearch;
    }
    const idx = new VectorIndex(opts);
    idx._capacity = state.capacity;
    idx._buf = state.buf;
    idx._idAt = state.idAt;
    idx._slotOf = state.slotOf;
    idx._freeSlots = state.freeSlots;
    idx._size = state.size;
    // Topology arrays must match the deserialized capacity. Re-allocate
    // before installing persisted topology (or before rebuildTopology
    // runs for v1 payloads).
    idx._levels = new Int32Array(state.capacity);
    idx._levels.fill(-1);
    idx._neighbors = new Array(state.capacity).fill(null);
    idx._entryPoint = -1;
    idx._entryLevel = -1;
    if (state.hnsw) {
      idx._levels = state.hnsw.levels;
      idx._neighbors = state.hnsw.neighbors;
      idx._entryPoint = state.hnsw.entryPoint;
      idx._entryLevel = state.hnsw.entryLevel;
    } else {
      console.log(
        `VectorIndex: rebuilding HNSW topology from v1 snapshot ` +
        `(${idx._size} vectors)`
      );
      rebuildTopology(idx);
    }
    return idx;
  }

  /** Double the underlying buffer when slots are exhausted. Topology
   *  arrays grow alongside via ensureTopology. @private */
  _grow() {
    const newCap = this._capacity * 2;
    const newBuf = new Float32Array(newCap * this.dims);
    newBuf.set(this._buf);
    this._buf = newBuf;
    this._idAt.length = newCap;
    for (let i = this._capacity; i < newCap; i++) this._idAt[i] = null;
    this._capacity = newCap;
    ensureTopology(this);
  }
}

export default VectorIndex;
