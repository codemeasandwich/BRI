/**
 * Type utilities and change publishing
 */

import { createPatch } from 'rfc6902';
import JSS from '../utils/jss/index.js';

/**
 * Convert a type name to a short 4-character code
 * @param {string} type - Type name (e.g., "user", "userS")
 * @returns {string} - Short code (e.g., "USER")
 */
export const type2Short = (type) => {
  if ("string" === typeof type) {
    const start = type.slice(0, 2);
    let end = type.slice(-2);
    if (type.endsWith('S')) {
      end = type.slice(-3, -1);
    }
    return `${start}${end}`.toUpperCase();
  }
};

/**
 * Create a publish function bound to store and genid
 * @param {Object} store - Storage adapter
 * @param {Function} genid - ID generator function
 * @returns {Function} - Publish function
 */
export function createPublisher(store, genid) {
  /**
   * Publish a change event
   * @param {Object} oldVal - Old document state
   * @param {Object} newVal - New document state
   * @param {string} action - Action type ('CREATE', 'UPDATE', 'DELETE')
   * @param {string} saveBy - ID of who made the change
   * @param {string} tag - Optional tag for the change
   * @returns {Promise} - Resolves when published
   */
  return function publish(oldVal, newVal, action, saveBy, tag) {
    const createdAt = new Date();

    return genid(type2Short('diff')).then(($ID) => {
      const patchs = createPatch(oldVal, newVal);

      if ('CREATE' !== action) {
        patchs.push({ op: 'test', path: '/updatedAt', value: oldVal.updatedAt });
      }
      const result = JSS.stringify({
        patchs,
        saveBy: saveBy || '',
        tag: tag || '',
        target: newVal.$ID,
        $ID,
        createdAt,
        action
      });
      return store.publish((newVal.$ID || oldVal.$ID).split('_')[0], result);
    });
  };
}
