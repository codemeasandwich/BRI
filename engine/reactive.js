/**
 * Reactive proxy system for change tracking
 */

import { undeclared, MAKE_COPY } from './constants.js';
import { isObjectOrArray, mapObjectOrArray } from './helpers.js';
import JSS from '../utils/jss/index.js';

/**
 * Wrap an object in a reactive proxy that tracks all changes
 * @param {Object} context - { wrapper, populate, txnId } - wrapper for save, populate for .and, txnId for transactions
 * @param {Object} rootObj - Object to wrap
 * @returns {Proxy} - Reactive proxy
 */
export function watchForChanges({ wrapper, populate, txnId }, rootObj) {
  let db; // Will be set when accessed via $DB

  const watch = (percent, path = [], changes = []) => {
    const thisProxy = new Proxy(percent, {

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
            get(target, prop) {
              return populate(prop)
                .then(xDB => watchForChanges({ wrapper, populate }, xDB));
            }
          });
        } else if ("$DB" === name) {
          return db;
        }

        const value = target[name];
        if (isObjectOrArray(value)) {
          const path2 = Array.isArray(target) ? [...path, parseInt(name)]
            : [...path, name];
          return watch(value, path2, changes);
        }
        return value;
      },

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
          if (isObjectOrArray(target) && isObjectOrArray(value)) {
            changes.push([path2, Array.isArray(value) ? [] : {}, undeclared]);
          }
          const entries = mapObjectOrArray(value, path2, oldVal);
          changes.push(...entries);
        } else {
          changes.push([path2, value, oldVal]);
        }

        target[name] = value;
        return true;
      },

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
