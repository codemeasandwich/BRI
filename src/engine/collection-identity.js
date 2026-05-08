/**
 * @file Collection storage identity diagnostics and collision errors.
 *
 * Domain context: Bri derives durable document prefixes, collection membership
 * sets, and group-read namespaces from a compact storage identity. Two logical
 * collections sharing that identity would make persisted rows ambiguous, so the
 * database treats uniqueness as an invariant rather than a caller convention.
 *
 * Technical context: the helpers here are pure and synchronous. The schema
 * registry, public operation proxies, and storage adapter all use the same
 * projection and error construction so declaration, write, read, recovery, and
 * diagnostics report the same conflict shape.
 */

import { BriRecoveryError, BriSchemaError } from './errors.js';

/**
 * Build a deterministic user-facing conflict list.
 *
 * @param {string} requested - Collection being checked.
 * @param {string} existing - Collection already bound to the same identity.
 * @returns {string[]} Sorted unique collection names.
 */
function sortedCollections(requested, existing) {
  return [...new Set([requested, existing])].sort();
}

/**
 * Create a typed schema-time/write-time collection identity collision.
 *
 * @param {string} collection - Requested collection name.
 * @param {string} existingCollection - Existing conflicting collection name.
 * @param {string} storageIdentity - Derived durable identity/prefix.
 * @returns {BriSchemaError} Actionable typed error.
 */
export function createCollectionIdentityCollisionError(
  collection,
  existingCollection,
  storageIdentity
) {
  const collections = sortedCollections(collection, existingCollection);
  return new BriSchemaError({
    code: 'COLLECTION_IDENTITY_COLLISION',
    message:
      `Collection storage identity collision: collections ` +
      `${collections.join(' and ')} both derive durable prefix ` +
      `${storageIdentity}. Rename one collection before writing data, or ` +
      `migrate the persisted store so each logical collection has a unique ` +
      `storage identity.`,
    details: {
      collections,
      collection,
      existingCollection,
      storageIdentity,
      prefix: storageIdentity
    }
  });
}

/**
 * Create a recovery-time error for an already persisted ambiguous catalog.
 *
 * @param {string} collection - Collection loaded from persisted identity state.
 * @param {string} existingCollection - Earlier loaded conflicting collection.
 * @param {string} storageIdentity - Durable identity/prefix shared by both.
 * @returns {BriRecoveryError} Actionable recovery error.
 */
export function createCollectionIdentityRecoveryError(
  collection,
  existingCollection,
  storageIdentity
) {
  const collections = sortedCollections(collection, existingCollection);
  return new BriRecoveryError({
    code: 'COLLECTION_IDENTITY_COLLISION',
    message:
      `Persisted collection identity catalog is ambiguous: collections ` +
      `${collections.join(' and ')} both map to durable prefix ` +
      `${storageIdentity}. Bri refuses to boot because collection group reads ` +
      `could mix logical rows. Restore from a clean backup or migrate one ` +
      `collection to a unique name before replaying the store.`,
    details: {
      collections,
      collection,
      existingCollection,
      storageIdentity,
      prefix: storageIdentity
    }
  });
}

/**
 * Turn a collection→identity map plus optional candidate names into public
 * diagnostic rows.
 *
 * @param {Map<string,string>} known - Registered/persisted identities.
 * @param {string[]} candidates - Optional projected collection names.
 * @param {Function} derive - Function deriving storage identity from name.
 * @returns {Array<Object>} Public diagnostic rows sorted by collection name.
 */
export function collectionIdentityDiagnostics(known, candidates, derive) {
  const projected = new Map(known);
  for (const collection of candidates || []) {
    if (!projected.has(collection)) projected.set(collection, derive(collection));
  }

  const byIdentity = new Map();
  for (const [collection, storageIdentity] of projected) {
    if (!byIdentity.has(storageIdentity)) byIdentity.set(storageIdentity, []);
    byIdentity.get(storageIdentity).push(collection);
  }

  return [...projected.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([collection, storageIdentity]) => {
      const conflicts = byIdentity.get(storageIdentity)
        .filter((other) => other !== collection)
        .sort();
      return {
        collection,
        storageIdentity,
        prefix: storageIdentity,
        unique: conflicts.length === 0,
        conflicts
      };
    });
}
