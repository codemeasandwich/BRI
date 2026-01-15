import { UNDECLARED } from './symbols.js';

/**
 * Checks if a value is a plain object or array (traversable).
 * Excludes Date, Error, Set, Map, and other special objects.
 *
 * @param {*} value - Value to check
 * @returns {boolean} - True if value is a plain object or array
 */
export function isPlainObject(value) {
  return 'object' === typeof value
    && value !== null
    && !(value instanceof Date)
    && !(value instanceof Error)
    && !(value instanceof Set)
    && !(value instanceof Map);
}

/**
 * Recursively flattens a nested object/array into an array of [path, value, oldRef] tuples.
 *
 * @param {Object|Array} objOrArray - Object or array to flatten
 * @param {Array} path - Current path (array of keys/indices)
 * @param {*} oldRef - Reference to old value at this path (or UNDECLARED)
 * @returns {Array} - Array of [path, value, oldRef] tuples
 */
export function flattenToPathValues(objOrArray, path = [], oldRef = UNDECLARED) {
  return Object.entries(objOrArray)
    .reduce((entries, [prop, val]) => {
      const propPath = [...path, Array.isArray(objOrArray) ? +prop : prop];
      const oldValue = oldRef !== UNDECLARED && oldRef.hasOwnProperty(prop)
        ? oldRef[prop]
        : UNDECLARED;

      return entries.concat(
        isPlainObject(val)
          ? flattenToPathValues(val, propPath, oldValue)
          : [[propPath, val, oldValue]]
      );
    }, []);
}
