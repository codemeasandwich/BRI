/**
 * @file Remove operation for the database engine
 * Handles soft-deletion of entities with audit trail
 */

import { type2Short } from './types.js';

// Delete operations normally receive identity hooks from the public proxy.
// The default keeps direct engine callers compatible without creating a new
// identity reservation path when no registry boundary is available.
const defaultRemoveInternal = {
  beforeDurableWrite: Boolean,
  rollbackCollectionIdentity: Boolean
};

/**
 * Creates the remove operation function bound to store, wrapper, and publish
 * @param {Object} store - Storage adapter instance
 * @param {Object} wrapper - Operations wrapper object for get calls
 * @param {Function} publish - Publish function for change notifications
 * @returns {Function} The remove operation function
 */
export function createRemoveOperation(store, wrapper, publish) {

  /**
   * Soft-deletes an entity by type and ID
   * @param {string} type - The entity type (e.g., 'user')
   * @param {string|Object} $ID - The entity ID or object with $ID property
   * @param {string} deletedBy - ID of the entity performing the deletion
   * @param {Object} opts - Middleware-visible options; delete storage remains immediately durable.
   * @returns {Promise} Promise resolving to the deleted item (without deletion metadata)
   */
  return function remove(type, $ID, deletedBy, opts, internal) {
    $ID = $ID && $ID.$ID || $ID;
    const hooks = Object.assign({}, defaultRemoveInternal, internal);

    if ("string" != typeof $ID || !$ID.includes('_')) {
      throw new Error(`"${$ID}" is not a valid ID`);
    }

    if (!deletedBy || typeof deletedBy !== 'string' || !deletedBy.includes('_')) {
      wrapper._logger?.warn({
        event: 'engine.remove.deleted_by_missing',
        message: 'Who is deleting this?',
        metadata: { type, $ID, deletedBy }
      });
    }

    const shortType = type2Short(type);

    if ("string" == typeof $ID && $ID.split('_')[0] !== shortType) {
      throw new Error(`${$ID} is not a type of "${type}"`);
    }

    let identityAdded = false;
    return wrapper.get(type, $ID)
      .then(item => {
        if (!item) {
          throw new Error(`"${$ID}" was not found`);
        }

        return Promise.resolve()
          .then(() => hooks.beforeDurableWrite())
          .then((added) => {
            identityAdded = !!added;
          })
          .then(() => publish(item, {}, 'DELETE', deletedBy))
          .then(() => {
            item.deletedAt = new Date();
            item.deletedBy = deletedBy;
            return item.save();
          }).then(() => {
            return Promise.all([
              store.rename($ID, "X:" + $ID + ":X"),
              store.sRem(`${shortType}?`, $ID.split('_').pop())
            ]);
          }).then(() => {
            const output = { ...item };
            delete output.deletedAt;
            delete output.deletedBy;
            return output;
          });
      }).catch(async (err) => {
        if (identityAdded) {
          try { await hooks.rollbackCollectionIdentity(); } catch {}
        }
        throw err;
      });
  };
}
