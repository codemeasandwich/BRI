/**
 * @file Get operation for the database engine
 * Handles single item retrieval and group queries with population support
 */

import JSS from '../utils/jss/index.js';
import { MAKE_COPY } from './constants.js';
import { type2Short } from './types.js';
import { attachToString, checkMatch, isMatch } from './helpers.js';
import { watchForChanges } from './reactive.js';

/**
 * Creates the get operation function bound to store and wrapper
 * @param {Object} store - Storage adapter instance
 * @param {Object} wrapper - Operations wrapper object for recursive calls
 * @returns {Function} The get operation function
 */
export function createGetOperation(store, wrapper) {

  /**
   * Retrieves items from the database by type and selector
   * @param {string} type - The entity type (e.g., 'user', 'userS' for groups)
   * @param {string|Object|Array|Function} where - Selector: ID string, query object, array of IDs, or filter function
   * @param {Object} opts - Options including txnId for transactions
   * @returns {Promise} Promise resolving to item(s) with populate() and .and proxy
   */
  return function get(type, where, opts = {}) {
    // Extract txnId from opts (3rd arg) or from where if it has txnId
    let txnId = opts.txnId;

    // Check if 'where' is actually an opts object (has txnId but no $ID)
    const whereIsOptsObject = 'object' === typeof where && where !== null && where.txnId && !where.$ID;
    if (whereIsOptsObject) {
      txnId = where.txnId;
      where = undefined;
    }

    // Only throw error for undefined if it's not a group call (ending with S) and not an opts object
    // Group calls (type ending with S) are allowed to have no where argument
    const isGroupCall = type && type.endsWith('S');
    if (2 === arguments.length && undefined === where && !whereIsOptsObject && !isGroupCall) {
      throw new Error(`You are trying to pass 'undefined' to .get.${type}(...)`);
    }

    if ('string' === typeof type
      && !type.endsWith('S')
      && !where) {
      const errMessage = `You are missing your selector argument for ${type}`;
      console.error(new Error(errMessage).stack);
      throw new Error(errMessage);
    }

    let $ID = '';
    if ('string' === typeof where) {
      if (null === type || where.startsWith(type2Short(type)))
        $ID = where;
      else
        throw new Error(`Type ${type} does not match ID:${where}`);
    } else if ('object' === typeof where) {
      if (where.$ID) {
        if (where.$ID.startsWith(type2Short(type))) {
          $ID = where.$ID;
        } else {
          throw new Error(`Type ${type} does not match ID:${where.$ID}`);
        }
      } else if (!where.txnId && !Array.isArray(where)) {
        const matchThis = where;
        where = (source) => checkMatch(matchThis, source);
      }
    }

    const groupCall = (type && type.endsWith('S')) || this.groupCall;

    /**
     * Populates referenced entities in the result
     * @param {string|Array} key - Key(s) to populate
     * @returns {Promise} Promise with populated data and chainable populate()
     */
    const populate = key => {
      const keys = 'string' === typeof key ? [key] : key;

      /**
       * Processes a single entry for population
       * @param {Object} percent - The item to process
       * @returns {Promise} Promise resolving to populated item
       */
      const processEntry = (percent) => {
        if (!percent || (groupCall && 0 === percent.length)) {
          return percent;
        }
        // Get the reactive copy before Object.assign strips the proxy
        const copy = percent[MAKE_COPY] || Object.assign({}, percent);
        percent = Object.assign({}, percent);

        return Promise.all(
          keys.map((key) => {
            if (!percent[key]) {
              if (groupCall) {
                return undefined;
              } else {
                throw new Error(`Cannot populate non-existing key "${key}"`);
              }
            }
            if (Array.isArray(percent[key])) {
              return Promise.all(percent[key].map(k => wrapper.get(null, k)));
            }
            return wrapper.get(null, percent[key]);
          })
        ).then((population) => {
          population.forEach((val, index) => {
            copy[keys[index]] = val;
          });
          return copy;
        });
      };

      const output = result.then(data => {
        if (Array.isArray(data)) {
          return Promise.all(data.map(processEntry));
        }
        return processEntry(data);
      });
      output.populate = populate;
      return output;
    };

    const result = Promise.resolve().then(() => {
      if ($ID.includes('_')) {
        return store.get($ID, { txnId }).then((x) => {
          if (!x) {
            return x;
          }
          const adb = JSS.parse(x);
          if ("object" === where && !checkMatch(where, adb)) {
            return null;
          }

          // Recursively attach toString to nested objects with $ID
          attachToString(adb);

          return watchForChanges({ wrapper, populate, txnId },
            Object.assign(Object.create({
              toObject: () => adb,
              toString: () => $ID
            }), adb));
        });
      } else {
        // Detect if where is a query object (for group filtering with isMatch)
        const whereIsQueryObj = where && (where + "").startsWith('[object');

        // Validate group selection arguments
        if (type &&
          type.endsWith('S') &&
          undefined !== where &&
          !Array.isArray(where) &&
          "function" !== typeof where &&
          !whereIsQueryObj) {
          let value = where.toString();
          try {
            value = JSON.stringify(where);
          } catch (e) {}
          throw new Error(`Group selection must have no argument, an Array, or a filter Object. ".get.${type}(${value})"`);
        }

        let IDsPromise;
        if (Array.isArray(where)) {
          IDsPromise = Promise.resolve(where);
        } else {
          IDsPromise = store.sMembers(`${type2Short(type)}?`, { txnId });
        }
        IDsPromise = IDsPromise.then(ids => {
          const prefix = `${type2Short(type)}_`;
          return ids.map(id => id.startsWith(prefix) ? id : prefix + id);
        });

        return IDsPromise.then($IDs =>
          Promise.all($IDs.map($ID => wrapper.get(null, $ID, { txnId })))
            .then(items =>
              items.filter(item => {
                if ('function' === typeof where) {
                  return where(item);
                }
                if (whereIsQueryObj) {
                  return isMatch(where, item);
                }
                return true;
              })
            )
        );
      }
    });

    result.populate = populate;

    result.and = new Proxy({}, {
      get(target, prop) {
        return result.populate(prop);
      }
    });

    return result;
  };
}
