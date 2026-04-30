/**
 * @file Reactive proxy system for change tracking
 *
 * Wraps document bodies in nested Proxy objects so writes are recorded as
 * change-paths and replayed on .save(). Also serves as the integration
 * point for predicate-aware property access — the get-trap consults the
 * schema registry (via wrapper._registry) and routes registered predicates
 * to resolvePredicateAccess from engine/predicate-proxy.js.
 */

import { undeclared, MAKE_COPY } from './constants.js';
import { isObjectOrArray, mapObjectOrArray } from './helpers.js';
import { resolvePredicateAccess } from './predicate-proxy.js';
import JSS from '../utils/jss/index.js';

/**
 * Wrap an object in a reactive proxy that tracks all changes
 * @param {Object} context - { wrapper, populate, txnId } - wrapper for save, populate for .and, txnId for transactions
 * @param {Object} rootObj - Object to wrap
 * @returns {Proxy} - Reactive proxy
 */
export function watchForChanges({ wrapper, populate, txnId }, rootObj) {
  let db; // Will be set when accessed via $DB

  /**
   * Recursively wrap an object/array in a reactive proxy.
   * @param {Object|Array} percent - Body to wrap
   * @param {Array} [path] - Field path from the root for nested objects
   * @param {Array} [changes] - Mutable change-log array shared up the tree
   * @returns {Proxy}
   */
  const watch = (percent, path = [], changes = []) => {
    const thisProxy = new Proxy(percent, {

      /**
       * Read trap: handles built-in handlers (toJSON/toJSS/save/and/$DB),
       * predicate-proxy resolution, then falls through to field access.
       * @param {Object} target
       * @param {string|symbol} name
       * @param {Object} receiver
       * @returns {*}
       */
      get(target, name, receiver) {
        if ("toJSON" === name) {
          return () => target;
        }
        if ("toJSS" === name) {
          return () => JSON.parse(JSS.stringify(target));
        }

        if (MAKE_COPY === name) {
          return watch({ ...target }, path, changes);
        }

        if ('save' === name) {
          return (saveByOrOpts = '', tag) => {
            if (0 === changes.length) {
              return Promise.resolve(thisProxy);
            }
            const lastUpdatedAt = target.updatedAt;
            target.updatedAt = new Date();
            changes.push([["updatedAt"], target.updatedAt, lastUpdatedAt]);
            const changes2save = [...changes];
            changes.length = 0;

            // Handle opts object or legacy saveBy/tag args
            let saveBy = '';
            let saveTxnId = txnId;
            if ('object' === typeof saveByOrOpts && saveByOrOpts !== null) {
              if (saveByOrOpts.$ID) {
                // It's an object with $ID, use as saveBy
                saveBy = saveByOrOpts.$ID;
              } else {
                // It's an opts object
                saveBy = saveByOrOpts.saveBy || '';
                tag = saveByOrOpts.tag || tag;
                saveTxnId = saveByOrOpts.txnId || txnId;
              }
            } else if (true === saveByOrOpts) {
              saveBy = target.$ID;
            } else if ('string' === typeof saveByOrOpts) {
              saveBy = saveByOrOpts;
            }

            return wrapper.update(target, changes2save, { saveBy, tag, txnId: saveTxnId })
              .then(moreCurrentVersionOfData => watch(moreCurrentVersionOfData, path, changes));
          };
        } else if ("and" === name) {
          return new Proxy({}, {
            /**
             * .and.{field} populates the named ref field and re-wraps the
             * resolved object with the reactive proxy.
             * @param {Object} target
             * @param {string} prop
             * @returns {Promise<Object>}
             */
            get(target, prop) {
              return populate(prop)
                .then(xDB => watchForChanges({ wrapper, populate }, xDB));
            }
          });
        } else if ("$DB" === name) {
          return db;
        }

        // Predicate-proxy lookup: if this collection has registered an
        // edge schema where this entity is a valid `from` and `name` is
        // one of the registered predicates, return a PredicateAccessor
        // (callable for write, awaitable for read). Returns undefined if
        // the access doesn't resolve to a predicate, in which case we
        // continue with the existing field-access fall-through.
        if (typeof name === 'string'
            && wrapper && wrapper._registry
            && !(name in target)) {
          const accessor = resolvePredicateAccess(target, name, wrapper._registry, wrapper);
          if (accessor !== undefined) return accessor;
        }

        const value = target[name];
        if (isObjectOrArray(value)) {
          const path2 = Array.isArray(target) ? [...path, parseInt(name)]
            : [...path, name];
          return watch(value, path2, changes);
        }
        return value;
      },

      /**
       * Write trap: records a change-path entry, then mutates the target.
       * @param {Object} target
       * @param {string|symbol} name
       * @param {*} value
       * @param {Object} receiver
       * @returns {boolean} true (Proxy contract)
       */
      set(target, name, value, receiver) {
        if (['$ID', 'updatedAt', 'createdAt'].includes(name)
          || target[name] === value) {
          return true;
        }

        if (Array.isArray(target)) {
          if ('length' === name) {
            return true;
          }
          if (isNaN(parseInt(name))) {
            return delete target[name];
          }
        }

        const path2 = Array.isArray(target) ? [...path, parseInt(name)]
          : [...path, name];
        let oldVal = target.hasOwnProperty(name) ? target[name] : undeclared;

        if (Array.isArray(target[name]) && "object" === typeof value) {
          changes.push([path2, {}, oldVal]);
        } else if (Array.isArray(value) && "object" === typeof target[name]) {
          changes.push([path2, [], oldVal]);
        }

        if (isObjectOrArray(value) && Object.keys(value).length) {
          // When replacing with a nested object, stage an empty scaffold before
          // mapObjectOrArray emits leaf tuples (targets are always reactive
          // object/array roots — see get-trap recursion).
          changes.push([path2, Array.isArray(value) ? [] : {}, undeclared]);
          const entries = mapObjectOrArray(value, path2, oldVal);
          changes.push(...entries);
        } else {
          changes.push([path2, value, oldVal]);
        }

        target[name] = value;
        return true;
      },

      /**
       * Delete trap: records the deletion as a change-path entry then
       * removes the field/index.
       * @param {Object} target
       * @param {string|symbol} name
       * @returns {boolean} true (Proxy contract)
       */
      deleteProperty(target, name) {
        if (!target.hasOwnProperty(name)) {
          return true;
        }
        const path2 = Array.isArray(target) ? [...path, parseInt(name)]
          : [...path, name];

        changes.push([path2, undeclared, target[name]]);
        if (Array.isArray(target)) {
          target.splice(name, 1);
        } else {
          delete target[name];
        }
        return true;
      }
    });
    return thisProxy;
  };
  return watch(rootObj);
}
