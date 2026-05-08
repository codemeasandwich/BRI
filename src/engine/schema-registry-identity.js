/**
 * @file Schema-registry bridge for collection storage identity enforcement.
 *
 * Domain context: schema declaration is the earliest point where Bri can learn
 * that a logical collection name exists, so it must reserve the derived storage
 * identity before vector, graph, cascade, or secondary-index state mutates.
 *
 * Technical context: this adapter keeps storage-backed identity checks behind a
 * tiny synchronous/asynchronous facade that the main schema registry can call
 * without carrying the collision bookkeeping inline.
 */

import { type2Short } from './types.js';
import {
  collectionIdentityDiagnostics,
  createCollectionIdentityCollisionError
} from './collection-identity.js';

/**
 * Create collection identity helpers bound to the optional storage adapter.
 *
 * @param {Object|undefined} store - Storage adapter with identity methods.
 * @returns {Object} Identity enforcement facade.
 */
export function createSchemaRegistryIdentity(store) {
  const local = store && typeof store.getCollectionIdentities === 'function'
    ? store.getCollectionIdentities()
    : new Map();

  /**
   * Reserve a collection identity in local memory when no store is attached.
   *
   * @param {string} collection - Logical collection name.
   * @param {string} storageIdentity - Derived storage identity.
   */
  function registerLocal(collection, storageIdentity) {
    for (const [otherCollection, otherIdentity] of local) {
      if (otherCollection !== collection && otherIdentity === storageIdentity) {
        throw createCollectionIdentityCollisionError(
          collection,
          otherCollection,
          storageIdentity
        );
      }
    }
    local.set(collection, storageIdentity);
  }

  return {
    /**
     * Reserve the derived identity for a declared schema collection.
     *
     * @param {string} collection - Logical collection name.
     * @returns {string} Derived storage identity.
     */
    declare(collection) {
      const storageIdentity = type2Short(collection);
      if (store && typeof store.registerCollectionIdentity === 'function') {
        store.registerCollectionIdentity(collection, storageIdentity);
      } else {
        registerLocal(collection, storageIdentity);
      }
      local.set(collection, storageIdentity);
      return storageIdentity;
    },

    /**
     * Backwards-compatible registration alias used by tests and adapters.
     *
     * @param {string} collection - Logical collection name.
     * @returns {void}
     */
    register(collection) {
      this.declare(collection);
    },

    /**
     * Ensure a collection identity exists before an async write path proceeds.
     *
     * @param {string} collection - Logical collection name.
     * @returns {Promise<void>}
     */
    async ensure(collection) {
      const storageIdentity = type2Short(collection);
      if (store && typeof store.ensureCollectionIdentity === 'function') {
        await store.ensureCollectionIdentity(collection, storageIdentity);
      }
      local.set(collection, storageIdentity);
    },

    /**
     * Assert a read path is not entering an ambiguous collection namespace.
     *
     * @param {string} collection - Logical collection name.
     * @returns {void}
     */
    assert(collection) {
      const storageIdentity = type2Short(collection);
      if (store && typeof store.assertCollectionIdentity === 'function') {
        store.assertCollectionIdentity(collection, storageIdentity);
      }
    },

    /**
     * Return public identity diagnostics for known and candidate collections.
     *
     * @param {string[]} [collections] - Optional candidate collection names.
     * @returns {Array<Object>} Diagnostic rows.
     */
    diagnostics(collections = []) {
      const latest = store && typeof store.getCollectionIdentities === 'function'
        ? store.getCollectionIdentities()
        : local;
      return collectionIdentityDiagnostics(latest, collections, type2Short);
    }
  };
}
