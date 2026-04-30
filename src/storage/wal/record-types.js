/**
 * @file Named WAL record types per spec §3.3.
 *
 * The WAL writer is generic — it appends `entry` objects with an `action`
 * discriminator. The recovery layer routes records to handlers based on
 * `entry.action`. This module exports the canonical action names used
 * across the codebase so the producer/consumer agree on a single
 * vocabulary, and so the spec's "new WAL record types" surface exists
 * as a first-class API.
 *
 * Record-type vocabulary (spec §3.3):
 *
 *   Document-level (existing, unchanged):
 *     SET     — document body inserted or replaced
 *     DELETE  — document deleted
 *     RENAME  — document $ID changed
 *     SADD    — set member added (legacy `Set` collection ops)
 *     SREM    — set member removed
 *
 *   Index-level (added in v1 vector + graph slice — these are emitted
 *   alongside SET/DELETE so a recovery that only knows SET/DELETE still
 *   replays correctly; the explicit names exist for debug/observability
 *   and as a stable contract for v2 worker-thread offload):
 *     INDEX_INSERT       — secondary index entry inserted
 *     INDEX_REMOVE       — secondary index entry removed
 *     INDEX_UPDATE       — secondary index entry replaced (old key removed,
 *                          new key inserted)
 *     VECTOR_ADD         — vector embedding added or replaced
 *     VECTOR_REMOVE      — vector embedding removed
 *     VECTOR_COMMIT_TXN  — transaction commit marker (flush staged ops)
 *     VECTOR_ROLLBACK_TXN — transaction rollback marker (drop staged ops)
 *
 * The vector-index and secondary-index modules apply their changes
 * synchronously to the in-process indexes; persistence is handled by the
 * snapshot/recovery layer. The record types here are present on the WAL
 * surface so post-mortem inspection and v2 cross-process replication can
 * route by name.
 *
 * Backwards compatibility: every record-type string in this module is
 * NEW. Existing record types ('SET', 'DELETE', 'RENAME', 'SADD', 'SREM')
 * are unchanged and continue to be the primary persistence channel for
 * documents. Old WALs replay without modification.
 */

/**
 * Frozen vocabulary of WAL action names.
 *
 * @readonly
 */
export const WAL_RECORD_TYPES = Object.freeze({
  // Document-level (unchanged from prior versions)
  SET:                  'SET',
  DELETE:               'DELETE',
  RENAME:               'RENAME',
  SADD:                 'SADD',
  SREM:                 'SREM',

  // Index-level (new in v1 vector + graph slice)
  INDEX_INSERT:         'INDEX_INSERT',
  INDEX_REMOVE:         'INDEX_REMOVE',
  INDEX_UPDATE:         'INDEX_UPDATE',
  VECTOR_ADD:           'VECTOR_ADD',
  VECTOR_REMOVE:        'VECTOR_REMOVE',
  VECTOR_COMMIT_TXN:    'VECTOR_COMMIT_TXN',
  VECTOR_ROLLBACK_TXN:  'VECTOR_ROLLBACK_TXN'
});

// Individual exports so callers can `import { VECTOR_ADD } from '...'`
// rather than typing the string literal at every emission site.
export const SET                 = WAL_RECORD_TYPES.SET;
export const DELETE              = WAL_RECORD_TYPES.DELETE;
export const RENAME              = WAL_RECORD_TYPES.RENAME;
export const SADD                = WAL_RECORD_TYPES.SADD;
export const SREM                = WAL_RECORD_TYPES.SREM;
export const INDEX_INSERT        = WAL_RECORD_TYPES.INDEX_INSERT;
export const INDEX_REMOVE        = WAL_RECORD_TYPES.INDEX_REMOVE;
export const INDEX_UPDATE        = WAL_RECORD_TYPES.INDEX_UPDATE;
export const VECTOR_ADD          = WAL_RECORD_TYPES.VECTOR_ADD;
export const VECTOR_REMOVE       = WAL_RECORD_TYPES.VECTOR_REMOVE;
export const VECTOR_COMMIT_TXN   = WAL_RECORD_TYPES.VECTOR_COMMIT_TXN;
export const VECTOR_ROLLBACK_TXN = WAL_RECORD_TYPES.VECTOR_ROLLBACK_TXN;

/**
 * Test whether a record type is a document-level mutation (SET/DELETE/etc.)
 * vs an index-level marker. The recovery layer uses this to route
 * payloads to the right handler.
 *
 * @param {string} action - WAL `entry.action` value
 * @returns {boolean} true if the record affects document storage
 */
export function isDocumentRecord(action) {
  return action === SET || action === DELETE || action === RENAME
      || action === SADD || action === SREM;
}

/**
 * Test whether a record type is a vector-index marker.
 *
 * @param {string} action - WAL `entry.action` value
 * @returns {boolean} true if the record affects only vector index state
 */
export function isVectorRecord(action) {
  return action === VECTOR_ADD || action === VECTOR_REMOVE
      || action === VECTOR_COMMIT_TXN || action === VECTOR_ROLLBACK_TXN;
}

/**
 * Test whether a record type is a secondary-index marker.
 *
 * @param {string} action - WAL `entry.action` value
 * @returns {boolean} true if the record affects only secondary index state
 */
export function isSecondaryIndexRecord(action) {
  return action === INDEX_INSERT || action === INDEX_REMOVE
      || action === INDEX_UPDATE;
}
