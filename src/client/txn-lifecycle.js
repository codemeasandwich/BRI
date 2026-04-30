/**
 * @file Transaction lifecycle bindings for the public db interface.
 *
 * Why this lives in client/ (not engine/): the bindings here are the user-
 * facing rec/fin/nop/pop methods, plus the cross-layer hooks that mirror
 * storage-layer commits and rollbacks into the schema registry's vector
 * indexes (UC-V4 deferred-linking buffers).
 *
 * Order constraint (binding):
 *   The vector lifecycle hooks fire AFTER store.fin/nop/pop resolves —
 *   storage must have already committed or rolled back before the index
 *   mirrors that change. Reversing the order would let an outside-txn
 *   observer see a half-applied state where the index has flushed but the
 *   docs haven't.
 */

import { type2Short } from '../engine/types.js';

/**
 * Build the lifecycle methods bound to a store + registry. Returns an
 * object suitable for spreading into the db interface.
 *
 * @param {Object} store - Storage adapter
 * @param {Object} registry - Schema registry
 * @param {Function} getDb - Lazy db accessor (for clearing _activeTxnId)
 * @returns {Object} {rec, fin, nop, pop, txnStatus}
 */
export function createTxnLifecycle(store, registry, getDb) {
  return {
    /**
     * rec(opts?) — start recording, returns txnId AND sets it as active.
     *
     * Optional `{sessionId}` tags the txn with a session owner so cascade
     * routines can identify and cancel an in-flight txn that belongs to
     * the cancelled session (spec §2.8 / non-negotiable §0.3 #5). Other
     * sessions' txns are not touched. The tag is informational; the
     * txn behaves identically with or without it.
     *
     * @param {Object} [opts]
     * @param {string} [opts.sessionId] - Optional session owner tag
     * @returns {string} new txnId
     */
    rec: (opts) => {
      const txnId = store.rec();
      const db = getDb();
      db._activeTxnId = txnId;
      db._activeTxnSessionId = (opts && opts.sessionId) || null;
      return txnId;
    },

    /**
     * fin(txnId) — commit transaction.
     *
     * Vector lifecycle: after the storage layer commits, flush each
     * registered vector index's pending buffer for this txnId so staged
     * adds become visible to outside-txn searches.
     *
     * @param {string} [txnId] - Defaults to active txnId
     * @returns {Promise<*>} store.fin's resolved value
     */
    fin: (txnId) => {
      const db = getDb();
      txnId = txnId || db._activeTxnId;
      if (!txnId) {
        throw new Error('No transaction to commit');
      }
      return store.fin(txnId).then(result => {
        for (const [_collection, index] of registry.vectorIndices()) {
          index.commit(txnId);
        }
        if (db._activeTxnId === txnId) {
          db._activeTxnId = null;
          db._activeTxnSessionId = null;
        }
        return result;
      });
    },

    /**
     * nop(txnId) — cancel transaction.
     *
     * Vector lifecycle: discard each index's pending buffer so staged
     * adds leave no trace in the committed buffer or anywhere else.
     *
     * @param {string} [txnId] - Defaults to active txnId
     * @returns {Promise<*>} store.nop's resolved value
     */
    nop: (txnId) => {
      const db = getDb();
      txnId = txnId || db._activeTxnId;
      if (!txnId) {
        throw new Error('No transaction to cancel');
      }
      return store.nop(txnId).then(result => {
        for (const [_collection, index] of registry.vectorIndices()) {
          index.rollback(txnId);
        }
        if (db._activeTxnId === txnId) {
          db._activeTxnId = null;
          db._activeTxnSessionId = null;
        }
        return result;
      });
    },

    /**
     * pop(txnId) — undo last action.
     *
     * Vector lifecycle: if the popped action was a SET on a vector-bearing
     * collection (matched by $ID prefix vs type2Short(collection)), drop
     * the most recent staged op for that $ID so the pending buffer matches
     * the storage-side rollback exactly.
     *
     * Note: a single db.add records SET + SADD in the txn — so undoing a
     * full add takes two pop() calls.
     *
     * @param {string} [txnId] - Defaults to active txnId
     * @returns {Promise<Object|null>} the popped action (null if none)
     */
    pop: (txnId) => {
      const db = getDb();
      txnId = txnId || db._activeTxnId;
      if (!txnId) {
        throw new Error('No transaction to pop from');
      }
      return store.pop(txnId).then(action => {
        if (action && action.action === 'SET' && action.target) {
          const prefix = action.target.split('_')[0];
          for (const [collection, index] of registry.vectorIndices()) {
            if (type2Short(collection) === prefix) {
              index.popStaged(txnId, action.target);
            }
          }
        }
        return action;
      });
    },

    /**
     * txnStatus(txnId) — proxy through to the storage layer.
     *
     * @param {string} [txnId] - Defaults to active txnId
     * @returns {Object} status from store.txnStatus
     */
    txnStatus: (txnId) => {
      const db = getDb();
      txnId = txnId || db._activeTxnId;
      return store.txnStatus(txnId);
    }
  };
}

export default createTxnLifecycle;
