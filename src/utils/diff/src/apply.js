import { UNDECLARED } from './symbols.js';

/**
 * Applies an array of changes to create a new object overlay.
 * Does not mutate the source object.
 *
 * @param {Array} changes - Array of [path, newValue, oldValue] tuples
 * @param {Object} source - Original source object for structure reference
 * @returns {Object} - New object with changes applied
 */
export function applyChanges(changes, source) {
  const result = {};

  for (const [path, value] of changes) {
    let obj = result;
    let walkWithSource = source;

    // Navigate/create nested structure using array path
    for (let i = 0; i < path.length - 1; i++) {
      walkWithSource = walkWithSource && walkWithSource[path[i]];

      if (!obj[path[i]]) {
        const isArray = 'number' === typeof path[i + 1];
        if (walkWithSource) {
          obj[path[i]] = isArray ? [...walkWithSource] : { ...walkWithSource };
        } else {
          obj[path[i]] = isArray ? [] : {};
        }
      }
      obj = obj[path[i]];
    }

    // Set or delete the final value
    const lastKey = path[path.length - 1];
    if (UNDECLARED === value) {
      if (Array.isArray(obj)) {
        obj.splice(lastKey, 1);
      } else {
        delete obj[lastKey];
      }
    } else {
      obj[lastKey] = value;
    }
  }

  return result;
}
