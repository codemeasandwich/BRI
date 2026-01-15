/**
 * Checks if a subset object partially matches a source object.
 * All keys in subset must exist and match in source.
 *
 * @param {Object} subset - Object with keys to match
 * @param {Object} source - Object to match against
 * @returns {boolean} - True if all subset keys match in source
 */
export function isPartialMatch(subset, source) {
  const keys = Object.keys(subset);

  for (const key of keys) {
    const value1 = subset[key];
    const value2 = source[key];

    if ('object' === typeof value1 && 'object' === typeof value2) {
      if (!isPartialMatch(value1, value2)) {
        return false;
      }
    } else if (value1 !== value2) {
      return false;
    }
  }
  return true;
}

/**
 * Deep equality check for objects, arrays, and primitives.
 *
 * @param {*} query - First value to compare
 * @param {*} input - Second value to compare
 * @returns {boolean} - True if values are deeply equal
 */
export function isDeepEqual(query, input) {
  if (Array.isArray(query) && Array.isArray(input)) {
    if (query.length !== input.length) {
      return false;
    }
    return query.every((item, index) => isDeepEqual(item, input[index]));
  }

  if (typeof query === 'object' && typeof input === 'object'
      && query !== null && input !== null) {
    for (const key of Object.keys(query)) {
      if (!(key in input) || !isDeepEqual(query[key], input[key])) {
        return false;
      }
    }
    return true;
  }

  return query === input;
}
