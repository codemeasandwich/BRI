/**
 * @file Per-transaction deferred-linking buffer for the vector index.
 *
 * Role in the system:
 *   Spec §7.1 chooses deferred linking over tombstone-marking-applied
 *   entries: pending writes inside an open txn never touch the committed
 *   index until db.fin() flushes them, so commit semantics are atomic and
 *   crash recovery is automatically pre-txn (the committed buffer was
 *   never modified). This module owns the bookkeeping; the wrapper class
 *   in vector-index.js delegates and exposes it through unchanged public
 *   methods (addStaged / removeStaged / commit / rollback / popStaged /
 *   searchInTxn). Extracting it here keeps the wrapper under the 200-NCLOC
 *   ceiling and keeps the txn surface reviewable independent of the HNSW
 *   topology code.
 *
 * Why free functions over a class:
 *   The buffer is just a Map<txnId, Array<{op,id,vec}>> stored on the
 *   index instance. Free functions that take the index as their first arg
 *   stay aligned with the rest of vector-index-hnsw.js, which uses the
 *   same shape — both modules treat the index as a structured POJO and
 *   never reach back through `this`.
 *
 * Dependencies:
 *   - vector-index-codec.js → cosine() (used by the merge path)
 *
 * Consumers:
 *   - engine/vector-index.js — the VectorIndex class wraps these functions
 *
 * Invariants:
 *   - Pending ops are appended in arrival order; popStaged walks back-to-front.
 *   - searchInTxnMerged is read-only — it never mutates the pending bucket.
 *   - commit applies pending ops to the committed index in order; the
 *     wrapper's add/remove methods (passed via `applyAdd` / `applyRemove`)
 *     drive the topology mutation so the txn module itself stays free of
 *     HNSW knowledge.
 */

import { cosine } from './vector-index-codec.js';

/**
 * Buffer one staged add. Validates dims up front so an oversize/undersize
 * vector fails the same way as the non-txn add() path; the wrapper turns
 * the throw into a write-time validation error visible to the caller.
 *
 * Why we copy the vector: the caller's array may be mutated after staging
 * (a common pattern when callers reuse a scratch buffer across writes).
 * Float32Array keeps the storage representation consistent with the
 * committed buffer, so commit() doesn't need a re-cast on flush.
 *
 * @param {Object} index - VectorIndex instance
 * @param {string} txnId
 * @param {string} id
 * @param {ArrayLike<number>} vector
 * @throws {Error} on dims mismatch
 */
export function stageAdd(index, txnId, id, vector) {
  if (vector.length !== index.dims) {
    throw new Error(
      `VectorIndex.addStaged: vector dimension mismatch for ${id}: ` +
      `expected ${index.dims}, got ${vector.length}.`
    );
  }
  if (!index._pending.has(txnId)) index._pending.set(txnId, []);
  const copy = new Float32Array(index.dims);
  for (let i = 0; i < index.dims; i++) copy[i] = vector[i];
  index._pending.get(txnId).push({ op: 'add', id, vec: copy });
}

/**
 * Buffer one staged remove. Symmetric to stageAdd; commit applies via
 * the wrapper's remove() so the topology drops the node.
 * @param {Object} index
 * @param {string} txnId
 * @param {string} id
 */
export function stageRemove(index, txnId, id) {
  if (!index._pending.has(txnId)) index._pending.set(txnId, []);
  index._pending.get(txnId).push({ op: 'remove', id, vec: null });
}

/**
 * Flush all staged ops for one txn to the committed index in arrival
 * order, then drop the bucket. Idempotent — calling commit on an unknown
 * txnId is a no-op so callers don't need to track which collections had
 * staged ops.
 *
 * The applyAdd / applyRemove callbacks defer to the wrapper's public
 * add/remove so HNSW topology stays in sync exactly the same way it
 * would for a non-txn write.
 *
 * @param {Object} index
 * @param {string} txnId
 * @param {(id:string, vec:Float32Array) => void} applyAdd
 * @param {(id:string) => void} applyRemove
 */
export function commitTxn(index, txnId, applyAdd, applyRemove) {
  const ops = index._pending.get(txnId);
  if (!ops) return;
  for (const { op, id, vec } of ops) {
    if (op === 'add') applyAdd(id, vec);
    else if (op === 'remove') applyRemove(id);
  }
  index._pending.delete(txnId);
}

/**
 * Discard all pending ops for txnId without touching the committed index.
 * Idempotent.
 * @param {Object} index
 * @param {string} txnId
 */
export function rollbackTxn(index, txnId) {
  index._pending.delete(txnId);
}

/**
 * Drop the most recent pending op for the given $ID within txnId. Used
 * by the wrapper's pop() handler when a popped action targeted a
 * vector-bearing doc.
 * @param {Object} index
 * @param {string} txnId
 * @param {string} id
 * @returns {boolean} true if a pending op was popped, false otherwise
 */
export function popStagedOp(index, txnId, id) {
  const ops = index._pending.get(txnId);
  if (!ops || ops.length === 0) return false;
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].id === id) {
      ops.splice(i, 1);
      if (ops.length === 0) index._pending.delete(txnId);
      return true;
    }
  }
  return false;
}

/**
 * Search merging the committed index with the pending log for one txn.
 *
 * Algorithm (unchanged across the v1→v2 backend swap because it sits
 * ABOVE the index data structure):
 *   1. Run the wrapper's committed search via `committedSearch` (which
 *      points at searchFiltered).
 *   2. Score every pending add for this txn against the query, replacing
 *      committed results with the same id (later-staged wins).
 *   3. Drop committed results whose id appears as a pending 'remove'.
 *   4. Re-sort and truncate to k.
 *
 * Why a "wide" committed search: the committed search runs with a higher
 * k so that drop/replace operations during the merge don't truncate
 * genuine hits below the caller's requested k. wideK = k + |stagedAdds|
 * + |stagedRemoves| is a safe upper bound: every pending add can replace
 * at most one committed entry, every pending remove drops at most one.
 *
 * @param {Object} index
 * @param {ArrayLike<number>} query
 * @param {number} k
 * @param {string} txnId
 * @param {((id:string)=>boolean)|null} predicate
 * @param {Object} opts - efSearch override forwarded to the committed search
 * @param {(query, k, predicate, opts) => Array<{id,score}>} committedSearch
 * @returns {Array<{id:string, score:number}>}
 */
export function searchInTxnMerged(index, query, k, txnId, predicate, opts, committedSearch) {
  const ops = index._pending.get(txnId) || [];
  const stagedRemoves = new Set();
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
  const wideK = k + stagedAdds.size + stagedRemoves.size;
  const committed = committedSearch(query, wideK,
    (id) => (!predicate || predicate(id)) && !stagedRemoves.has(id),
    opts);
  const merged = committed.slice();
  for (const [id, vec] of stagedAdds) {
    if (predicate && !predicate(id)) continue;
    const score = cosine(query, vec);
    const existingIdx = merged.findIndex(h => h.id === id);
    if (existingIdx >= 0) merged[existingIdx] = { id, score };
    else merged.push({ id, score });
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.length > k ? merged.slice(0, k) : merged;
}

export default { stageAdd, stageRemove, commitTxn, rollbackTxn, popStagedOp, searchInTxnMerged };
