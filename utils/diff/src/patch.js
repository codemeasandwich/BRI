import { UNDECLARED } from './symbols.js';
import { isPlainObject, flattenToPathValues } from './traverse.js';

/**
 * Converts an array path to JSON Pointer format.
 * @param {Array} path - Array of keys/indices
 * @returns {string} - JSON Pointer string (e.g., '/foo/bar/0')
 */
function pathToPointer(path) {
  if (path.length === 0) return '';
  return '/' + path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/**
 * Creates a JSON Patch array by comparing two objects.
 * @param {Object} oldVal - Original object
 * @param {Object} newVal - New object
 * @returns {Array} - Array of JSON Patch operations
 */
export function createPatch(oldVal, newVal) {
  const patches = [];

  // Flatten both objects to path-value pairs
  const oldEntries = isPlainObject(oldVal) ? flattenToPathValues(oldVal) : [];
  const newEntries = isPlainObject(newVal) ? flattenToPathValues(newVal) : [];

  // Create maps for lookup
  const oldMap = new Map();
  for (const [path, value] of oldEntries) {
    oldMap.set(pathToPointer(path), { path, value });
  }

  const newMap = new Map();
  for (const [path, value] of newEntries) {
    newMap.set(pathToPointer(path), { path, value });
  }

  // Find additions and replacements
  for (const [pointer, { path, value }] of newMap) {
    if (!oldMap.has(pointer)) {
      patches.push({ op: 'add', path: pointer, value });
    } else if (oldMap.get(pointer).value !== value) {
      patches.push({ op: 'replace', path: pointer, value });
    }
  }

  // Find removals
  for (const [pointer, { path, value }] of oldMap) {
    if (!newMap.has(pointer)) {
      patches.push({ op: 'remove', path: pointer });
    }
  }

  return patches;
}
