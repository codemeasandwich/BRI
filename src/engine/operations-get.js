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
   * Retrieves items from the database by type and selector.
   *
   * @param {string} type - Singular collection (`user`) or plural group accessor (`userS`, ends with `S`)
   * @param {string|Object|Array|Function} where - Selector: typed `$ID`, query object, ID array, predicate function, etc.
   * @param {Object} opts - Options (e.g. `txnId` for transactional reads)
   * @returns {Promise} Promise extended with `.populate` / `.and`:
   *   The async **fulfillment value** depends on the selector:
   *   - **Singular path** (`where` narrows to one typed `$ID` containing `_`): fulfills **`null`** when the row is absent or fails `checkMatch` against the parsed body; otherwise fulfills the **reactive entity proxy** returned by `watchForChanges` wrapping the JSS-parsed document (`toObject`, `toString`, change tracking, predicate routing — see `engine/reactive.js`).
   *   - **Group / plural path** (`type` ends with `S`, ID array, or membership listing): fulfills an **array** of per-row entities — each element is the fulfillment of `wrapper.get(null, $ID)` after ID normalization / filtering (`where` predicate or `isMatch`), so each entry matches the singular reactive shape above (not a bare POJO snapshot unless the row truly resolves that way).
   *   The returned promise object has **own** `.populate` (relation expansion) and `.and` (Proxy sugar calling the same populate) attached for chaining.
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
      wrapper._logger?.error({
        event: 'engine.get.selector_missing',
        message: new Error(errMessage).stack,
        metadata: { collection: type }
      });
      throw new Error(errMessage);
    }

    let $ID = '';
    if ('string' === typeof where) {
      if (null === type || where.startsWith(type2Short(type)))
        $ID = where;
      else
        throw new Error(`Type ${type} does not match ID:${where}`);
    } else if ('object' === typeof where) {
      // $ID branch: constrain by typed id. Otherwise singular calls turn plain
      // filter objects into checkMatch predicates; group (*.S) calls keep literals
      // so downstream whereIsQueryObj paths can use deep isMatch filtering.
      if (where.$ID) {
        if (where.$ID.startsWith(type2Short(type))) {
          $ID = where.$ID;
        } else {
          throw new Error(`Type ${type} does not match ID:${where.$ID}`);
        }
      } else if (!where.txnId && !Array.isArray(where) && !isGroupCall) {
        const matchThis = where;
        where = (source) => checkMatch(matchThis, source);
      }
    }

    const groupCall = (type && type.endsWith('S')) || this.groupCall;

    /**
     * Expands foreign-key fields on an already-materialized `.get` result by awaiting nested `wrapper.get(null, ref)` loads.
     *
     * Preconditions: awaits the outer `result` promise — i.e. operates on whatever singular entity or entity array `.get` settled with.
     *
     * @param {string|Array<string>} key - One relation field name or several fields to hydrate in one batch.
     * @returns {Promise} Extended Promise (`output.populate === populate`) whose fulfillment value is:
     *   - **Passthrough**: if the fulfilled payload is falsy, or a group query produced an empty row array, fulfills with that same value (`null`, `undefined`, or `[]`) without issuing nested reads.
     *   - **Singular row**: fulfills with **`percent[MAKE_COPY]`** — the reactive merge fork created by the reactive proxy (`engine/reactive.js`) — after shallow-cloning `percent` and assigning each requested field from the **fulfillment** of `wrapper.get(null, id)` (or `Promise.all` across ids when the stored field is an array of `$ID`s). Nested loads resolve to the same engine entity shape as top-level `.get` (reactive proxies + nested `.populate`/`.and`).
     *   - **Plural rows**: when `result` fulfilled with an array, maps `processEntry` across rows and fulfills with a **parallel array** of merged forks (same per-row semantics as singular).
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
        // Reactive wrappers always expose MAKE_COPY via the Proxy get trap so
        // populate can fork a nested proxy bundle for merge results.
        const copy = percent[MAKE_COPY];
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
          if (
            typeof where === 'object' &&
            where !== null &&
            !Array.isArray(where) &&
            !checkMatch(where, adb)
          ) {
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
      /**
       * Implements `result.and.<field>` as pure syntax sugar: **`return result.populate(field)`** — same closure, same fulfillment semantics as calling `.populate` explicitly on this `.get` promise.
       *
       * Therefore the promise settles exactly as documented on `populate`:
       * singular merged **`percent[MAKE_COPY]`** fork with nested `wrapper.get` results wired in, group **`Array`** of those merges, or **`null` / `undefined` / `[]`** passthrough when the outer row materialization yielded nothing to expand.
       *
       * @param {object} _target - Unused Proxy target (`new Proxy` handler contract)
       * @param {string|symbol} prop - Relation field name forwarded to `populate`
       * @returns {Promise} Same extended Promise instance `populate(prop)` returns (`then` fulfillment per rules above; own `.populate` chain intact)
       */
      get(_target, prop) {
        return result.populate(prop);
      }
    });

    return result;
  };
}
