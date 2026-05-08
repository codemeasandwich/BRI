/**
 * @file Collection identity catalog for the in-house storage adapter.
 *
 * Domain context: collection names derive durable prefixes used in `$ID`s,
 * membership sets, WAL replay routing, and group reads. Persisting that mapping
 * lets Bri reject ambiguous storage identities on boot instead of discovering
 * the hazard only after a later write.
 *
 * Technical context: identity catalog entries are stored as small internal WAL
 * `SET` records before the first row for a collection is written. Recovery
 * replays those records into hot storage, scans them, and rebuilds the in-memory
 * map before the database becomes READY.
 */

import JSS from '../../utils/jss/index.js';
import { createSetEntry } from '../wal/entry.js';
import {
  createCollectionIdentityCollisionError,
  createCollectionIdentityRecoveryError
} from '../../engine/collection-identity.js';

export const COLLECTION_IDENTITY_KEY_PREFIX = '__bri:collectionIdentity:';

/**
 * Build the internal storage key for one collection identity mapping.
 *
 * @param {string} collection - Logical collection name.
 * @returns {string} Internal document key.
 */
export function collectionIdentityKey(collection) {
  return `${COLLECTION_IDENTITY_KEY_PREFIX}${collection}`;
}

/**
 * Test whether a hot-tier key is an internal collection identity record.
 *
 * @param {string} key - Hot-tier document key.
 * @returns {boolean} True when the key stores identity metadata.
 */
export function isCollectionIdentityKey(key) {
  return typeof key === 'string' && key.startsWith(COLLECTION_IDENTITY_KEY_PREFIX);
}

/**
 * Create adapter methods that manage durable collection identity mappings.
 *
 * @returns {Object} Methods mixed into `InHouseAdapter.prototype`.
 */
export function createIdentityMethods() {
  return {
    /**
     * Register or validate one collection identity in memory.
     *
     * @param {string} collection - Logical collection name.
     * @param {string} storageIdentity - Derived durable identity/prefix.
     * @param {Object} [options] - Recovery mode swaps schema errors for boot errors.
     * @param {boolean} [options.recovery=false] - True during persisted catalog load.
     * @returns {boolean} True when this call added a new mapping.
     */
    registerCollectionIdentity(collection, storageIdentity, options = {}) {
      const existingForCollection = this._collectionIdentities.get(collection);
      if (existingForCollection && existingForCollection !== storageIdentity) {
        const makeError = options.recovery
          ? createCollectionIdentityRecoveryError
          : createCollectionIdentityCollisionError;
        throw makeError(collection, collection, storageIdentity);
      }

      for (const [otherCollection, otherIdentity] of this._collectionIdentities) {
        if (otherCollection !== collection && otherIdentity === storageIdentity) {
          const makeError = options.recovery
            ? createCollectionIdentityRecoveryError
            : createCollectionIdentityCollisionError;
          throw makeError(collection, otherCollection, storageIdentity);
        }
      }

      if (existingForCollection === storageIdentity) return false;
      this._collectionIdentities.set(collection, storageIdentity);
      return true;
    },

    /**
     * Validate a collection identity without persisting a new mapping.
     *
     * @param {string} collection - Logical collection name.
     * @param {string} storageIdentity - Derived durable identity/prefix.
     */
    assertCollectionIdentity(collection, storageIdentity) {
      const existingForCollection = this._collectionIdentities.get(collection);
      if (existingForCollection && existingForCollection !== storageIdentity) {
        throw createCollectionIdentityCollisionError(collection, collection, storageIdentity);
      }
      for (const [otherCollection, otherIdentity] of this._collectionIdentities) {
        if (otherCollection !== collection && otherIdentity === storageIdentity) {
          throw createCollectionIdentityCollisionError(
            collection,
            otherCollection,
            storageIdentity
          );
        }
      }
    },

    /**
     * Ensure a mapping is persisted before the first user row can be written.
     *
     * @param {string} collection - Logical collection name.
     * @param {string} storageIdentity - Derived durable identity/prefix.
     */
    async ensureCollectionIdentity(collection, storageIdentity) {
      this.registerCollectionIdentity(collection, storageIdentity);
      if (this._persistedCollectionIdentities.has(collection)) return;

      const payload = JSS.stringify({
        collection,
        storageIdentity,
        prefix: storageIdentity
      });
      const key = collectionIdentityKey(collection);
      await this.wal.append(createSetEntry(key, payload));
      await this.hotTier.set(key, payload, false);
      this._persistedCollectionIdentities.add(collection);
      this.logger?.debug({
        event: 'collection.identity.registered',
        message: `Collection identity registered: ${collection} -> ${storageIdentity}`,
        metadata: { collection, storageIdentity, prefix: storageIdentity }
      });
    },

    /**
     * Load snapshot-level collection identity state.
     *
     * @param {Object} state - `{collection: storageIdentity}` from snapshot v5.
     */
    loadCollectionIdentityState(state = {}) {
      for (const [collection, storageIdentity] of Object.entries(state || {})) {
        this.registerCollectionIdentity(collection, storageIdentity, { recovery: true });
        this._persistedCollectionIdentities.add(collection);
      }
    },

    /**
     * Rebuild identity mappings from internal hot-tier records after WAL replay.
     */
    loadCollectionIdentityDocumentsFromHot() {
      if (!this.hotTier) return;
      for (const [key, entry] of this.hotTier.documents) {
        if (!isCollectionIdentityKey(key) || entry.cold || !entry.data) continue;
        const parsed = JSS.parse(entry.data);
        this.registerCollectionIdentity(
          parsed.collection,
          parsed.storageIdentity || parsed.prefix,
          { recovery: true }
        );
        this._persistedCollectionIdentities.add(parsed.collection);
      }
    },

    /**
     * Return a copy of the registered collection identity map.
     *
     * @returns {Map<string,string>} Collection to storage identity.
     */
    getCollectionIdentities() {
      return new Map(this._collectionIdentities);
    }
  };
}
