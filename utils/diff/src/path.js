/**
 * Gets a value from an object using an array path.
 *
 * @param {Object} obj - Target object
 * @param {Array<string|number>} path - Array of keys/indices
 * @returns {*} - Value at path or undefined
 */
export function getByPath(obj, path) {
  return path.reduce((acc, key) => acc && acc[key], obj);
}

/**
 * Checks if one path is a prefix of another.
 *
 * @param {Array<string|number>} prefix - Potential prefix path
 * @param {Array<string|number>} fullPath - Path to check against
 * @returns {boolean} - True if prefix starts fullPath
 */
export function pathStartsWith(prefix, fullPath) {
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== fullPath[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Checks if two paths are equal.
 *
 * @param {Array<string|number>} path1 - First path
 * @param {Array<string|number>} path2 - Second path
 * @returns {boolean} - True if paths are equal
 */
export function pathEquals(path1, path2) {
  if (path1.length !== path2.length) {
    return false;
  }
  return path1.every((key, i) => key === path2[i]);
}
