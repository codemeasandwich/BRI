/**
 * @file Operation Proxy Factory
 *
 * Creates Proxy objects that intercept property access and function calls
 * to build RPC paths that match BRI's API (db.get.user, db.add.postS, etc.)
 *
 * Handles:
 * - db.get.user(id) - Get single by ID
 * - db.get.user({ $ID }) - Get single by ID object
 * - db.get.userS() - Get all
 * - db.get.userS({ field: value }) - Get all matching query object
 * - db.get.userS(fn) - Get all matching filter function (client-side filter)
 * - db.add.user(data, opts?) - Create entity
 * - db.set.user(data, opts?) - Replace entity
 * - db.del.user(id, deletedBy?) - Delete entity
 * - db.get.user(id).populate('field') - Get with population (chainable)
 */

/**
 * Create a chainable promise that supports .populate() method
 * @param {Promise} promise - The base promise
 * @param {Function} rpc - RPC function for populate calls
 * @param {Function} wrapEntity - Function to wrap entities
 * @returns {Promise} - Promise with .populate() method attached
 */
function createChainablePromise(promise, rpc, wrapEntity) {
  // Create a new promise that preserves the chain
  const chainable = promise.then(result => result);

  // Attach .populate() method to the promise
  chainable.populate = function(fields) {
    const fieldsArray = Array.isArray(fields) ? fields : [fields];

    const newPromise = promise.then(async (entity) => {
      // Handle null/undefined or non-entity results
      if (!entity || !entity.$ID) return entity;

      // Handle arrays - populate each entity
      if (Array.isArray(entity)) {
        const results = [];
        for (const item of entity) {
          if (item && item.$ID) {
            let current = item;
            for (const field of fieldsArray) {
              const populated = await rpc('db/populate', {
                entityId: current.$ID,
                field
              });
              current = wrapEntity(populated, rpc);
            }
            results.push(current);
          } else {
            results.push(item);
          }
        }
        return results;
      }

      // Single entity - populate sequentially
      let current = entity;
      for (const field of fieldsArray) {
        const populated = await rpc('db/populate', {
          entityId: current.$ID,
          field
        });
        current = wrapEntity(populated, rpc);
      }
      return current;
    });

    // Make result chainable too
    return createChainablePromise(newPromise, rpc, wrapEntity);
  };

  return chainable;
}

/**
 * Create a proxy for a CRUD operation (get, add, set, del)
 * @param {string} operation - The operation name (get, add, set, del)
 * @param {Function} rpc - The RPC function to call
 * @param {Function} wrapEntity - Function to wrap returned entities
 * @returns {Proxy} - Proxy that handles db.operation.collection(args)
 */
export function createOperationProxy(operation, rpc, wrapEntity) {
  return new Proxy({}, {
    /** @param {Object} target @param {string} collection @returns {Function} */
    get(target, collection) {
      // Return a function that performs the RPC
      return function(...args) {
        const resultPromise = executeOperation(operation, collection, args, rpc, wrapEntity);

        // For 'get' operations, wrap in chainable promise with .populate()
        if (operation === 'get') {
          return createChainablePromise(resultPromise, rpc, wrapEntity);
        }

        return resultPromise;
      };
    }
  });
}

/**
 * Execute a CRUD operation
 * @param {string} operation - Operation type (get, add, set, del)
 * @param {string} collection - Collection name
 * @param {Array} args - Function arguments
 * @param {Function} rpc - RPC function
 * @param {Function} wrapEntity - Entity wrapper function
 * @returns {Promise<any>}
 */
async function executeOperation(operation, collection, args, rpc, wrapEntity) {
  const rpcType = `db/${operation}/${collection}`;

  let payload;

  switch (operation) {
    case 'get': {
      const query = args[0];

      // Handle function filters client-side
      // Functions can't be serialized over the wire, so we:
      // 1. Fetch all entities of this type
      // 2. Filter locally with the function
      if (typeof query === 'function') {
        const filterFn = query;
        // Ensure plural form for "get all"
        const pluralCollection = collection.endsWith('S') ? collection : collection + 'S';
        const allResult = await rpc(`db/get/${pluralCollection}`, { query: undefined });

        // Filter client-side and wrap
        if (Array.isArray(allResult)) {
          return allResult
            .filter(item => {
              try {
                return filterFn(item);
              } catch (e) {
                return false;
              }
            })
            .map(item => wrapEntity(item, rpc));
        }
        return [];
      }

      // Normal query - send to server
      payload = { query };
      break;
    }

    case 'add':
      // db.add.user(data, opts?)
      // Forward opts (saveBy, tag, txnId) to server
      payload = { data: args[0], opts: args[1] || {} };
      break;

    case 'set':
      // db.set.user(data, opts?)
      // Forward opts (saveBy, tag, txnId) to server
      payload = { data: args[0], opts: args[1] || {} };
      break;

    case 'del':
      // db.del.user(id, deletedBy?)
      payload = { id: args[0], deletedBy: args[1] };
      break;

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }

  // Execute RPC
  const result = await rpc(rpcType, payload);

  // Wrap result in entity proxy for .and and .save support
  if (result && typeof result === 'object') {
    if (Array.isArray(result)) {
      return result.map(item => wrapEntity(item, rpc));
    }
    return wrapEntity(result, rpc);
  }

  return result;
}
