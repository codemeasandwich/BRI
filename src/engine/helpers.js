/**
 * Engine helper functions
 */

import { undeclared } from './constants.js';

/**
 * Strip nested objects with $ID to just their ID reference
 * @param {*} obj - Object to process
 * @param {boolean} first - If true, don't strip the root object
 * @returns {*} - Processed object
 */
export function stripDown$ID(obj, first) {
  if (Array.isArray(obj)) {
    return obj.map(x => stripDown$ID(x));
  }
  if (!obj || false === obj instanceof Object) return obj;
  if (!first && '$ID' in obj) return obj.$ID;
  if ('[object Object]' !== obj.toString()) return obj;

  const newObj = {};
  for (let key in obj) {
    newObj[key] = stripDown$ID(obj[key]);
  }
  return newObj;
}

/**
 * Recursively attach toString() to nested objects with $ID
 * This allows nested references to return their ID when converted to string
 * @param {Object} obj - Object to process
 * @param {WeakSet} visited - Set of visited objects
 */
export function attachToString(obj, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
  visited.add(obj);

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Check if this object has $ID and doesn't already have a custom toString
      if (value.$ID && value.toString() === '[object Object]') {
        const $ID = value.$ID;
        Object.setPrototypeOf(value, {
          toString: () => $ID,
          toObject: () => value
        });
      }
      attachToString(value, visited);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          if (item.$ID && item.toString() === '[object Object]') {
            const $ID = item.$ID;
            Object.setPrototypeOf(item, {
              toString: () => $ID,
              toObject: () => item
            });
          }
          attachToString(item, visited);
        }
      }
    }
  }
}

/**
 * Check if a subset object matches a source object
 * @param {Object} subset - Object with keys to match
 * @param {Object} source - Object to match against
 * @returns {boolean} - True if all subset keys match in source
 */
export function checkMatch(subset, source) {
  const objKeys1 = Object.keys(subset);
  for (var key of objKeys1) {
    const value1 = subset[key];
    const value2 = source[key];
    if ('object' === typeof value1 && 'object' === typeof value2) {
      if (!checkMatch(value1, value2)) return false;
    } else if (value1 !== value2) {
      return false;
    }
  }
  return true;
}

/**
 * Build an overlay object from changes
 * @param {Array} changes - Array of [path, value] tuples
 * @param {Object} source - Original source object
 * @returns {Object} - Overlay object with changes applied
 */
export function buildOverlayObject(changes, source) {
  const result = {};
  for (const [path, value] of changes) {
    let obj = result;
    let walkwithsource = source;

    for (let count = 0; count < path.length - 1; count++) {
      walkwithsource = walkwithsource && walkwithsource[path[count]];
      if (!obj[path[count]]) {
        const isArray = "number" === typeof path[count + 1];
        if (walkwithsource) {
          obj[path[count]] = isArray ? [...walkwithsource] : { ...walkwithsource };
        } else {
          obj[path[count]] = isArray ? [] : {};
        }
      }
      obj = obj[path[count]];
    }

    if (undeclared === value) {
      if (Array.isArray(obj)) {
        obj.splice(path[path.length - 1], 1);
      } else {
        delete obj[path[path.length - 1]];
      }
    } else {
      obj[path[path.length - 1]] = value;
    }
  }
  return result;
}

/**
 * Check if a value is a plain object or array
 * @param {*} value - Value to check
 * @returns {boolean} - True if value is a plain object or array
 */
export function isObjectOrArray(value) {
  return 'object' === typeof value
    && value !== null
    && !(value instanceof Date)
    && !(value instanceof Error)
    && !(value instanceof Set)
    && !(value instanceof Map);
}

/**
 * Map object or array entries to path-value tuples
 * @param {Object|Array} objOrArray - Object or array to map
 * @param {Array} path - Current path
 * @param {*} oldRef - Old reference value
 * @returns {Array} - Array of [path, value, oldRef] tuples
 */
export function mapObjectOrArray(objOrArray, path, oldRef) {
  return Object.entries(objOrArray)
    .reduce((entries, [prop, val], i, a) => {
      const propPath = [...path, Array.isArray(objOrArray) ? +prop : prop];
      return entries.concat(isObjectOrArray(val) ?
        mapObjectOrArray(val, propPath, oldRef.hasOwnProperty(prop) ? oldRef[prop] : undeclared)
        : [[propPath, val, oldRef]]);
    }, []);
}

/**
 * Find first matching item in a list of IDs
 * @param {Array} ids - List of IDs to search
 * @param {Function} testFn - Test function to match items
 * @param {Function} findOne - Function to load a single item
 * @returns {Promise} - First matching item or null
 */
export function findMatchingItem(ids, testFn, findOne) {
  let index = 1;

  const loadNrunFn = (item) => {
    let dataPromise = null;
    if (index < ids.length) {
      const $ID = ids[index];
      index++;
      dataPromise = findOne($ID, index);
    }

    const result = testFn(item);
    if (result) {
      return item;
    }
    return dataPromise ? dataPromise.then(loadNrunFn) : null;
  };

  if (ids.length) {
    return findOne(ids[0], 0).then(loadNrunFn);
  }
  return Promise.resolve(null);
}

/**
 * Deep equality check for arrays and objects
 * Used for matching query objects against database items
 * @param {*} query - Query pattern to match
 * @param {*} input - Input value to check
 * @returns {boolean} - True if input matches query pattern
 */
export function isMatch(query, input) {
    if (Array.isArray(query) && Array.isArray(input)) {
        // Compare arrays element by element
        if (query.length !== input.length) return false;
        return query.every((item, index) => isMatch(item, input[index]));
    }

    if (typeof query === 'object' && typeof input === 'object' && query !== null && input !== null) {
        // Compare objects key by key
        for (const key of Object.keys(query)) {
            if (!(key in input) || !isMatch(query[key], input[key])) {
                return false;
            }
        }
        return true;
    }

    // Direct comparison for non-objects and non-arrays
    return query === input;
}
