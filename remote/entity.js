/**
 * @file Remote Entity Wrapper
 *
 * Wraps plain objects from server to provide .and, .save(), and change tracking.
 * Mirrors BRI's native engine/reactive.js watchForChanges() behavior.
 */

const ENTITY_METHODS = ['and', 'save', 'populate', 'toObject', 'toJSON', 'toJSS', 'toString'];
const IMMUTABLE_FIELDS = ['$ID', 'createdAt'];
const ARRAY_READ_METHODS = ['map', 'filter', 'slice', 'concat', 'find', 'findIndex',
  'indexOf', 'includes', 'some', 'every', 'reduce', 'reduceRight', 'forEach', 'join', 'flat', 'flatMap'];

/**
 * Wrap a plain object as a remote entity with BRI-like methods
 * @param {Object} data - Plain object from server
 * @param {Function} rpc - RPC function for server calls
 * @returns {Proxy} - Entity with .and, .save(), etc.
 */
export function wrapEntity(data, rpc) {
  if (!data || typeof data !== 'object') return data;

  const changes = [];
  const rootId = data.$ID;

  /**
   * Create proxy for nested entity with .and support
   * @param {Object} value - Nested entity object
   * @returns {Proxy}
   */
  function wrapNestedEntity(value) {
    const nestedId = value.$ID;
    return new Proxy(value, {
      /** @param {Object} obj @param {string} prop @returns {*} */
      get(obj, prop) {
        if (prop === 'and') return createAndProxy(rpc, nestedId);
        if (prop === '$ID') return nestedId;
        const v = obj[prop];
        return (v && typeof v === 'object' && v.$ID) ? wrapEntity(v, rpc) : v;
      }
    });
  }

  /**
   * Handle array mutating methods
   * @param {Array} obj - Array object
   * @param {string} prop - Method name
   * @param {Array} path - Property path
   * @returns {Function|undefined}
   */
  function handleArrayMethod(obj, prop, path) {
    if (prop === 'length') return obj.length;
    if (prop === 'push') {
      return (...items) => {
        const start = obj.length;
        items.forEach((item, i) => changes.push([[...path, start + i], item]));
        return Array.prototype.push.apply(obj, items);
      };
    }
    if (prop === 'splice') {
      return (start, del, ...items) => {
        const r = Array.prototype.splice.call(obj, start, del, ...items);
        changes.push([path, [...obj]]);
        return r;
      };
    }
    if (prop === 'pop' || prop === 'shift') {
      return () => {
        const r = Array.prototype[prop].call(obj);
        changes.push([path, [...obj]]);
        return r;
      };
    }
    if (prop === 'unshift') {
      return (...items) => {
        const r = Array.prototype.unshift.apply(obj, items);
        changes.push([path, [...obj]]);
        return r;
      };
    }
    if (ARRAY_READ_METHODS.includes(prop)) {
      return (...args) => Array.prototype[prop].apply(obj, args);
    }
  }

  /**
   * Recursively wrap an object or array in a proxy
   * @param {Object|Array} target - Object to wrap
   * @param {Array} path - Property path from root
   * @returns {Proxy}
   */
  function wrap(target, path = []) {
    if (target === null || typeof target !== 'object') return target;

    return new Proxy(target, {
      /** @param {Object} obj @param {string|symbol} prop @returns {*} */
      get(obj, prop) {
        if (typeof prop === 'symbol') return obj[prop];

        // Root-level special methods
        if (path.length === 0) {
          if (prop === 'toObject' || prop === 'toJSS') return () => JSON.parse(JSON.stringify(data));
          if (prop === 'toJSON') return () => data;
          if (prop === 'toString') return () => rootId;
          if (prop === '$ID') return rootId;
          if (prop === 'save') return createSaveMethod(data, changes, rpc, rootId);
          if (prop === 'and') return createAndProxy(rpc, rootId);
          if (prop === 'populate') return createPopulateMethod(data, rpc, rootId);
        }

        const value = obj[prop];

        // Nested entity with $ID gets .and support
        if (value && typeof value === 'object' && value.$ID && prop !== 'and') {
          return wrapNestedEntity(value);
        }

        // Array methods
        if (Array.isArray(obj)) {
          const method = handleArrayMethod(obj, prop, path);
          if (method !== undefined) return method;
        }

        // Wrap nested objects/arrays
        if (value && typeof value === 'object') {
          const newPath = Array.isArray(obj) ? [...path, parseInt(prop)] : [...path, prop];
          return wrap(value, newPath);
        }

        return value;
      },

      /** @param {Object} obj @param {string|symbol} prop @param {*} value @returns {boolean} */
      set(obj, prop, value) {
        if (typeof prop === 'symbol') { obj[prop] = value; return true; }
        if (IMMUTABLE_FIELDS.includes(prop)) return true;
        if (obj[prop] === value) return true;
        if (Array.isArray(obj) && prop === 'length') { obj.length = value; return true; }

        const changePath = Array.isArray(obj) ? [...path, parseInt(prop)] : [...path, prop];
        changes.push([changePath, value]);
        obj[prop] = value;
        return true;
      },

      /** @param {Object} obj @param {string} prop @returns {boolean} */
      deleteProperty(obj, prop) {
        if (!Object.prototype.hasOwnProperty.call(obj, prop)) return true;
        const changePath = Array.isArray(obj) ? [...path, parseInt(prop)] : [...path, prop];
        changes.push([changePath, undefined]);
        Array.isArray(obj) ? obj.splice(parseInt(prop), 1) : delete obj[prop];
        return true;
      },

      /** @param {Object} obj @param {string} prop @returns {boolean} */
      has(obj, prop) {
        return (path.length === 0 && ENTITY_METHODS.includes(prop)) || prop in obj;
      },

      /** @param {Object} obj @returns {Array} */
      ownKeys(obj) { return Reflect.ownKeys(obj); },
      /** @param {Object} obj @param {string} prop @returns {PropertyDescriptor|undefined} */
      getOwnPropertyDescriptor(obj, prop) { return Reflect.getOwnPropertyDescriptor(obj, prop); }
    });
  }

  return wrap(data, []);
}

/**
 * Create the .and proxy for population chaining
 * @param {Function} rpc - RPC function
 * @param {string} entityId - Entity ID to populate from
 * @returns {Proxy}
 */
function createAndProxy(rpc, entityId) {
  return new Proxy({}, {
    /** @param {Object} _ @param {string} field @returns {Promise} */
    get(_, field) {
      return rpc('db/populate', { entityId, field }).then(r => wrapEntity(r, rpc));
    }
  });
}

/**
 * Create the .populate() method for entities
 * @param {Object} entity - Entity data
 * @param {Function} rpc - RPC function
 * @param {string} rootId - Root entity ID
 * @returns {Function}
 */
function createPopulateMethod(entity, rpc, rootId) {
  return function populate(fields) {
    const arr = Array.isArray(fields) ? fields : [fields];
    let promise = Promise.resolve(wrapEntity(entity, rpc));

    for (const field of arr) {
      promise = promise.then(async (e) => {
        const r = await rpc('db/populate', { entityId: e.$ID || rootId, field });
        return wrapEntity(r, rpc);
      });
    }

    promise.populate = (more) => promise.then(e => e.populate(more));
    return promise;
  };
}

/**
 * Create the .save() method
 * @param {Object} entity - Entity data
 * @param {Array} changes - Tracked changes array
 * @param {Function} rpc - RPC function
 * @param {string} rootId - Root entity ID
 * @returns {Function}
 */
function createSaveMethod(entity, changes, rpc, rootId) {
  return async function save(opts = {}) {
    if (changes.length === 0) return wrapEntity(entity, rpc);

    const changesObj = {};
    const seen = new Set();

    for (const [path, value] of changes) {
      const key = path[0];
      if (path.length === 1) changesObj[key] = value;
      else if (!seen.has(key)) { seen.add(key); changesObj[key] = entity[key]; }
    }

    changes.length = 0;

    let saveBy = '', tag = '';
    if (typeof opts === 'object' && opts !== null) {
      if (opts.$ID) saveBy = opts.$ID;
      else { saveBy = opts.saveBy || ''; tag = opts.tag || ''; if (saveBy === true) saveBy = rootId; }
    } else if (opts === true) saveBy = rootId;
    else if (typeof opts === 'string') saveBy = opts;

    const result = await rpc('db/save', { entityId: rootId, changes: changesObj, saveBy, tag });
    return wrapEntity(result, rpc);
  };
}
