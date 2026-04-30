/**
 * @file Core CRUD operations factory for the database engine
 * Orchestrates create, update, get, remove, cache, and replace operations
 */

import JSS from '../utils/jss/index.js';
import { type2Short } from './types.js';
import { stripDown$ID, buildOverlayObject } from './helpers.js';
import { createGetOperation } from './operations-get.js';
import { createRemoveOperation } from './operations-remove.js';

/**
 * Create CRUD operations wrapper bound to store
 * @param {Object} store - Storage adapter
 * @param {Object} deps - Dependencies object
 * @param {Function} deps.genid - ID generator function
 * @param {Function} deps.publish - Publish function for change notifications
 * @returns {Object} Wrapper object with sub, create, update, remove, get, cache, replace
 */
export function createOperations(store, { genid, publish }) {

  const wrapper = {

    /**
     * Subscribe to changes for a specific entity type
     * @param {string} type - The entity type to subscribe to
     * @param {Function} cb - Callback function receiving parsed entity data
     * @returns {Promise<Function>} Promise resolving to unsubscribe function
     */
    sub: (type, cb) => {
      const idType = type2Short(type);
      return store.subscribe(idType, (json) => {
        const data = JSS.parse(json);
        data.createdAt = new Date(data.createdAt);
        cb(data);
      }).then(() => {
        return () => store.unsubscribe(idType, cb);
      });
    },

    /**
     * Create a new entity of the specified type
     * @param {string} type - The entity type (cannot end with 's')
     * @param {Object} data - Entity data (must not have $ID)
     * @param {Object} opts - Options including tag, saveBy, txnId
     * @returns {Promise<Object>} Promise resolving to the created entity
     */
    create: (type, data, opts) => {
      let tag, saveBy, txnId;
      if (data.$ID) {
        throw new Error(`Trying to "add" an Object with ${data.$ID} to BRI`);
      }

      if (type.toLowerCase().endsWith("s")) {
        throw new Error(`Types cant end with 's'. You passed "${type}"`);
      }

      if ('object' === typeof opts) {
        tag = opts.tag || '';
        saveBy = opts.saveBy;
        txnId = opts.txnId;
      }
      const shortType = type2Short(type);
      return genid(shortType)
        .then(($ID) => {
          const percent = Object.assign({}, stripDown$ID(data));
          percent.$ID = $ID;
          percent.createdAt = new Date();
          percent.updatedAt = percent.createdAt;

          const saving = store.set($ID, JSS.stringify(percent), { txnId })
            .then(() => store.sAdd(`${shortType}?`, $ID.split("_").pop(), { txnId }));

          if (true === saveBy) {
            saveBy = $ID;
          }
          // Only publish if not in transaction (pub happens on fin)
          if (!txnId) {
            saving.then(() => publish({}, percent, 'CREATE', saveBy, tag));
          }
          return saving.then(() => wrapper.get(type, $ID, { txnId }));
        });
    },

    /**
     * Update an existing entity with changes (PRIVATE - used internally)
     * @param {Object} target - Target entity with $ID
     * @param {Array} changes2save - Array of changes to apply
     * @param {Object} opts - Options including tag, saveBy, txnId
     * @returns {Promise<Object>} Promise resolving to the updated entity
     */
    update: (target, changes2save, opts) => {
      let tag, saveBy, txnId;
      if ('object' === typeof opts) {
        tag = opts.tag || '';
        saveBy = opts.saveBy;
        txnId = opts.txnId;
      }
      if (0 === changes2save.length) {
        debugger;
      }

      return store.get(target.$ID, { txnId })
        .then(jss => JSS.parse(jss))
        .then(targetDb => {
          const diff = buildOverlayObject(changes2save, targetDb);
          const percent = Object.assign({}, targetDb, diff);

          if (true === saveBy) {
            saveBy = target.$ID;
          }
          const perToSave = stripDown$ID(percent, true);
          const saving = store.set(target.$ID, JSS.stringify(perToSave), { txnId });

          return saving.then(() => {
            // Only publish if not in transaction (pub happens on fin)
            if (!txnId) {
              publish(target, perToSave, 'UPDATE', saveBy, tag);
            }
            return percent;
          });
        });
    },

    /**
     * Cache a value with optional expiration (not yet implemented)
     * @param {string} key - Cache key
     * @param {*} val - Value to cache
     * @param {number} expire - Expiration time
     * @throws {Error} Always throws - not implemented
     */
    cache: function (key, val, expire) {
      throw new Error("still needs to be implemented!");
    },

    /**
     * Replace an entire entity with new data
     * @param {string} type - The entity type
     * @param {Object} replaceWith - New entity data (must have $ID)
     * @param {Object|string} optsORtag - Options object or tag string
     * @returns {Promise<Object>} Promise resolving to the replaced entity
     */
    replace: function (type, replaceWith, optsORtag) {
      if (!replaceWith.$ID.startsWith(type2Short(type))) {
        throw new Error(`${replaceWith.$ID} is not a type of ${type} `);
      }
      replaceWith = Object.assign({}, replaceWith, { updatedAt: new Date() });

      let tag, saveBy;

      if ('object' === typeof optsORtag) {
        tag = optsORtag.tag || '';
        saveBy = optsORtag.saveBy;
      } else if ('string' === typeof optsORtag) {
        tag = optsORtag;
      }
      return wrapper.get(type, replaceWith.$ID)
        .then((target) => {
          replaceWith.createdAt = target.createdAt;
          return store.set(replaceWith.$ID, JSS.stringify(replaceWith)).then(() => {
            publish(target, replaceWith, 'UPDATE', saveBy, tag);
            return replaceWith;
          });
        });
    }
  };

  // Inject get and remove operations from separate modules
  wrapper.get = createGetOperation(store, wrapper);
  wrapper.remove = createRemoveOperation(store, wrapper, publish);

  return wrapper;
}
