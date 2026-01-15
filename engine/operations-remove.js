/**
 * @file Remove operation for the database engine
 * Handles soft-deletion of entities with audit trail
 */

import { type2Short } from './types.js';

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
   * @returns {Promise} Promise resolving to the deleted item (without deletion metadata)
   */
  return function remove(type, $ID, deletedBy) {
    $ID = $ID && $ID.$ID || $ID;

    if ("string" != typeof $ID || !$ID.includes('_')) {
      throw new Error(`"${$ID}" is not a valid ID`);
    }

    if (!deletedBy || !deletedBy.includes('_')) {
      console.warn(`Who is deleting this?`, { type, $ID, deletedBy });
    }

    const shortType = type2Short(type);

    if ("string" == typeof $ID && $ID.split('_')[0] !== shortType) {
      throw new Error(`${$ID} is not a type of "${type}"`);
    }

    return wrapper.get(type, $ID)
      .then(item => {
        if (!item) {
          throw new Error(`"${$ID}" was not found`);
        }

        return publish(item, {}, 'DELETE', deletedBy)
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
      });
  };
}
