/**
 * @file Shared routing from document $ID keys into per-collection vector indices
 *
 * Domain: WAL recovery and low-level hard deletes must keep HNSW indices aligned
 * with document keys. db.del uses soft-delete (rename to a tombstone key), so
 * normal CRUD never emits WAL DELETE lines; recover()'s onDelete handler and
 * optional hardDelete() are the two places that remove a key outright and must
 * drop the same key from any vector index whose type prefix matches.
 *
 * Technical: collection names map to 4-char ID prefixes via type2Short(); we
 * reuse that map for both applyVectorWrite and applyVectorDelete in recovery
 * and for live hardDelete() so behavior stays identical between first-time
 * execution and replay.
 */

import { type2Short } from '../../engine/types.js';

/**
 * Build prefix string (e.g. VENK) → collection name for all vector-backed
 * collections currently registered on the store.
 *
 * @param {Map<string, {schema:Object, index:Object}>} vectorRegistry
 * @returns {Map<string, string>}
 */
export function buildPrefixToVectorCollectionMap(vectorRegistry) {
  const prefixToCollection = new Map();
  for (const [collection, _entry] of vectorRegistry) {
    prefixToCollection.set(type2Short(collection), collection);
  }
  return prefixToCollection;
}

/**
 * Remove a document key from the vector index for its collection, if any.
 * No-op when the key does not belong to a vector-backed type or the registry
 * has no entry (same early-return contract as recovery's applyVectorDelete).
 *
 * @param {Object} adapter - InHouseAdapter instance (uses _vectorRegistry)
 * @param {Map<string, string>} prefixToCollection - from buildPrefixToVectorCollectionMap
 * @param {string} key - Document $ID
 * @returns {void}
 */
export function removeFromVectorIndicesForKey(adapter, prefixToCollection, key) {
  const prefix = key.split('_')[0];
  const collection = prefixToCollection.get(prefix);
  if (!collection) return;
  adapter._vectorRegistry.get(collection)?.index.remove(key);
}
