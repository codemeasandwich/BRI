import { UNDECLARED } from './symbols.js';
import { isPlainObject, flattenToPathValues } from './traverse.js';

/**
 * Creates a proxy that tracks all changes to an object.
 * Changes are stored as [path, newValue, oldValue] tuples.
 *
 * @param {Object} target - The object to track
 * @param {Object} options - Optional configuration
 * @param {Function} options.onSave - Callback when .save() is called
 * @returns {Proxy} - Tracked object with .getChanges(), .save(), .clearChanges(), .toJSON()
 */
export function createChangeTracker(target, options = {}) {
  const { onSave } = options;

  const watch = (obj, path = [], changes = []) => {
    const proxy = new Proxy(obj, {

      get(target, name) {
        // Return JSON representation
        if ('toJSON' === name) {
          return () => target;
        }

        // Get accumulated changes
        if ('getChanges' === name) {
          return () => [...changes];
        }

        // Clear changes without triggering callback
        if ('clearChanges' === name) {
          return () => {
            changes.length = 0;
          };
        }

        // Save changes and optionally trigger callback
        if ('save' === name) {
          return async () => {
            if (changes.length === 0) {
              return proxy;
            }
            const changesToSave = [...changes];
            changes.length = 0;

            if (onSave) {
              await onSave(changesToSave);
            }
            return proxy;
          };
        }

        const value = target[name];

        // Recursively wrap nested objects/arrays
        if (isPlainObject(value)) {
          const nextPath = Array.isArray(target)
            ? [...path, parseInt(name)]
            : [...path, name];
          return watch(value, nextPath, changes);
        }

        return value;
      },

      set(target, name, value) {
        // Skip if value unchanged
        if (target[name] === value) {
          return true;
        }

        // Handle array length property
        if (Array.isArray(target) && 'length' === name) {
          return true;
        }

        const nextPath = Array.isArray(target)
          ? [...path, parseInt(name)]
          : [...path, name];

        const oldVal = target.hasOwnProperty(name) ? target[name] : UNDECLARED;

        // Handle type changes (array <-> object)
        if (Array.isArray(target[name]) && 'object' === typeof value && !Array.isArray(value)) {
          changes.push([nextPath, {}, oldVal]);
        } else if (Array.isArray(value) && 'object' === typeof target[name] && !Array.isArray(target[name])) {
          changes.push([nextPath, [], oldVal]);
        }

        // Handle nested objects/arrays - flatten to individual changes
        if (isPlainObject(value) && Object.keys(value).length) {
          if (isPlainObject(target) && isPlainObject(value)) {
            changes.push([nextPath, Array.isArray(value) ? [] : {}, UNDECLARED]);
          }
          const entries = flattenToPathValues(value, nextPath, oldVal);
          changes.push(...entries);
        } else {
          changes.push([nextPath, value, oldVal]);
        }

        target[name] = value;
        return true;
      },

      deleteProperty(target, name) {
        if (!target.hasOwnProperty(name)) {
          return true;
        }

        const nextPath = Array.isArray(target)
          ? [...path, parseInt(name)]
          : [...path, name];

        changes.push([nextPath, UNDECLARED, target[name]]);

        if (Array.isArray(target)) {
          target.splice(name, 1);
        } else {
          delete target[name];
        }

        return true;
      }
    });

    return proxy;
  };

  return watch(target);
}
