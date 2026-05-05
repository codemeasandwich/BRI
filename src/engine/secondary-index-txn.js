/**
 * @file Per-transaction rollback log for SecondaryIndexManager.
 *
 * Role in the system:
 *   Secondary indexes (`$indexes`, plus the UC-G3 canonical-pair index)
 *   are keyed off document field values via SecondaryIndexManager.
 *   Index updates fire from `vector-middleware.js` AFTER `next()`
 *   resolves, which means the storage layer has already accepted the
 *   write. When the write happens INSIDE an open transaction, storage
 *   stages the doc in a pending bucket — but the secondary index applies
 *   its update directly. If the transaction is later cancelled
 *   (`db.nop()`) or partially undone (`db.pop()`), storage rolls the doc
 *   back but the index entry remains, leaving a stale `(key → $ID)`
 *   mapping that cites a $ID with no document.
 *
 *   For UC-X1 / UC-V1 .where prefilter callers, the stale entry is
 *   benign at read time (`wrapper.get(null, $ID)` returns null and the
 *   filter drops the row). For UC-G3's canonical-pair uniqueness check,
 *   the stale entry is a real bug: a subsequent insert for the same
 *   unordered pair sees the rolled-back $ID and falsely throws
 *   EDGE_PAIR_NOT_UNIQUE. UC-G3 acceptance criterion 4 cites UC-V4,
 *   which mandates that `nop()` leave the index "bit-identical to its
 *   pre-rec() state" — this module is what makes that hold.
 *
 * Approach (log-and-undo, not deferred-linking):
 *   We write to the live index immediately, exactly as before. In
 *   parallel, when the write came from inside a transaction, we append
 *   an inverse-record to a per-txn buffer keyed by txnId. On commit, we
 *   drop the buffer (forward writes were correct). On rollback, we walk
 *   the buffer in reverse and apply each inverse op directly to the
 *   index. On pop (undo last), we apply the inverse of the most recent
 *   logged op for the popped $ID.
 *
 *   We pick log-and-undo over deferred-linking (the vector-index pattern)
 *   because secondary-index reads from inside the same txn must observe
 *   the staged write — that's what makes the canonical-pair uniqueness
 *   pre-check correct: an `add` followed by a second `add` of the same
 *   pair INSIDE THE SAME TXN must throw the second time. Deferred linking
 *   would hide the first write from the second, and uniqueness would
 *   silently fail. Log-and-undo keeps reads consistent at the cost of
 *   needing to undo on rollback.
 *
 * Snapshot crash recovery: out of scope here. The snapshot persists the
 * live index post-commit; a crash mid-txn loses the in-memory rollback
 * log along with the storage-layer pending bucket, so on next boot the
 * snapshot+WAL replay produces an index consistent with committed docs.
 *
 * Consumed by: engine/secondary-index.js (SecondaryIndexManager
 *   delegates the txn methods to these free functions, mirroring the
 *   vector-index → vector-index-txn split).
 * Consumes: nothing (pure utilities operating on the manager state).
 */

/**
 * Append one rollback-log entry for a manager-level op. The entry is
 * shallow-copied so subsequent caller-side mutations don't poison the
 * undo path (callers often reuse the same doc reference across multiple
 * middleware passes).
 *
 * @param {Object} mgr - SecondaryIndexManager instance
 * @param {string} txnId - Active transaction id
 * @param {Object} entry - {op:'insert'|'remove'|'update', collection, ...}
 * @returns {void}
 */
export function logTxnOp(mgr, txnId, entry) {
  if (!mgr._txnLog.has(txnId)) mgr._txnLog.set(txnId, []);
  mgr._txnLog.get(txnId).push(entry);
}

/**
 * Drop the rollback log for a committed transaction. The forward writes
 * are already in the live index; the log was the safety net for
 * undoing them and is no longer needed.
 *
 * @param {Object} mgr - SecondaryIndexManager instance
 * @param {string} txnId
 * @returns {void}
 */
export function commitTxn(mgr, txnId) {
  mgr._txnLog.delete(txnId);
}

/**
 * Walk the rollback log in reverse and apply each inverse op to the live
 * index. Required to make `db.nop()` leave the secondary index
 * bit-identical to its pre-`db.rec()` state (UC-V4 AC#2, cited by UC-G3
 * AC#4 for the canonical-pair uniqueness invariant).
 *
 * Inverse semantics:
 *   - 'insert' → undo via _applyRemove on the same doc snapshot.
 *   - 'remove' → undo via _applyInsert on the snapshot.
 *   - 'update' → reverse direction: remove(newDoc), then insert(oldDoc).
 *
 * The applies route through manager-private helpers that DO NOT log
 * (otherwise rollback itself would grow the log indefinitely).
 *
 * @param {Object} mgr - SecondaryIndexManager instance
 * @param {string} txnId
 * @returns {void}
 */
export function rollbackTxn(mgr, txnId) {
  const log = mgr._txnLog.get(txnId);
  if (!log) return;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.op === 'insert') {
      mgr._applyRemove(entry.collection, entry.doc);
    } else if (entry.op === 'remove') {
      mgr._applyInsert(entry.collection, entry.doc);
    } else if (entry.op === 'update') {
      mgr._applyRemove(entry.collection, entry.newDoc);
      mgr._applyInsert(entry.collection, entry.oldDoc);
    }
  }
  mgr._txnLog.delete(txnId);
}

/**
 * Undo the most recent logged op for a given $ID inside an open txn.
 * Mirrors the vector-index's `popStaged` so `db.pop()` rolls back the
 * secondary index in lock-step with the storage-layer pop.
 *
 * Why match by $ID rather than just popping the last entry:
 *   `db.pop` undoes the last storage action, identified by its target
 *   key. A single `db.add` records SET + SADD in storage, but only one
 *   logical doc op in the secondary index. The caller passes the popped
 *   $ID and we walk back to find the matching index op — multiple
 *   index-irrelevant actions may sit on top.
 *
 * @param {Object} mgr - SecondaryIndexManager instance
 * @param {string} txnId
 * @param {string} $ID - The popped document's $ID
 * @returns {void}
 */
export function popStagedOp(mgr, txnId, $ID) {
  const log = mgr._txnLog.get(txnId);
  if (!log || log.length === 0) return;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    const opId = entry.op === 'update' ? entry.newDoc.$ID : entry.doc.$ID;
    if (opId !== $ID) continue;
    if (entry.op === 'insert') {
      mgr._applyRemove(entry.collection, entry.doc);
    } else if (entry.op === 'remove') {
      mgr._applyInsert(entry.collection, entry.doc);
    } else if (entry.op === 'update') {
      mgr._applyRemove(entry.collection, entry.newDoc);
      mgr._applyInsert(entry.collection, entry.oldDoc);
    }
    log.splice(i, 1);
    if (log.length === 0) mgr._txnLog.delete(txnId);
    return;
  }
}
