/**
 * Client proxy handlers
 *
 * Creates the db.get.userS, db.add.user syntax via Proxy.
 * Now with middleware support for plugins and extensions.
 */

import { collectionNamePattern } from '../engine/constants.js';
import { createMiddleware, transactionMiddleware } from '../engine/middleware.js';

/**
 * Create a proxy handler that intercepts collection access
 * and runs operations through the middleware system.
 *
 * @param {Function} operation - The underlying operation (get, create, etc.)
 * @param {string} opName - Operation name ('get', 'add', 'set', 'del')
 * @param {Object} middleware - Middleware runner
 * @param {Function} getDb - Function to get db reference
 */
function createOperationProxy(operation, opName, middleware, getDb) {
  return new Proxy(function() {}, {
    get(target, prop) {
      // Validate collection name
      if (typeof prop === 'symbol') {
        return undefined;
      }
      if (!collectionNamePattern.test(prop)) {
        throw new Error(`"${prop} is not a good collection name"`);
      }

      // Return a function that runs through middleware
      return function(...args) {
        const db = getDb();

        // Build context for middleware
        const ctx = {
          operation: opName,
          type: prop,
          args: args,
          opts: {},
          db: db,
          result: undefined
        };

        // Extract opts from args based on operation type
        // For 'get': get(type, where, opts) - opts is 3rd arg or where could be opts
        // For 'add': add(type, data, opts) - opts is 3rd arg
        // For 'set': set(type, data, opts) - opts is 3rd arg
        // For 'del': del(type, $ID, deletedBy) - no opts currently

        if (opName === 'get') {
          // where could be: string ($ID), object (query or opts), or undefined
          const where = args[0];
          const explicitOpts = args[1];

          if (explicitOpts && typeof explicitOpts === 'object') {
            ctx.opts = { ...explicitOpts };
          } else if (where && typeof where === 'object' && 'txnId' in where && !where.$ID) {
            // where is actually an opts object (has txnId key, even if null/false)
            ctx.opts = { ...where };
            ctx.args = [undefined, ctx.opts];
          }
        } else if (opName === 'add' || opName === 'set') {
          const data = args[0];
          const optsArg = args[1];

          if (optsArg && typeof optsArg === 'object') {
            ctx.opts = { ...optsArg };
          }
        }

        // Run through middleware chain
        return middleware.run(ctx, (ctx) => {
          // Rebuild args with potentially modified opts
          let finalArgs;

          if (opName === 'get') {
            const where = ctx.args[0];
            // If opts has txnId and where is undefined (group call), pass opts as 2nd arg
            if (Object.keys(ctx.opts).length > 0) {
              finalArgs = [where, ctx.opts];
            } else {
              finalArgs = [where];
            }
          } else if (opName === 'add' || opName === 'set') {
            const data = ctx.args[0];
            if (Object.keys(ctx.opts).length > 0) {
              finalArgs = [data, ctx.opts];
            } else {
              finalArgs = [data];
            }
          } else {
            // del and others - pass through as-is for now
            finalArgs = ctx.args;
          }

          return operation.call(operation, prop, ...finalArgs);
        });
      };
    }
  });
}

/**
 * Create the public database interface from engine wrapper
 * @param {Object} wrapper - Engine wrapper
 * @param {Object} store - Storage adapter
 * @returns {Object} - Public DB interface
 */
export function createDBInterface(wrapper, store) {
  // Create middleware system
  const middleware = createMiddleware();

  // Register default transaction middleware
  middleware.use(transactionMiddleware());

  // The db object (we need a reference for middleware context)
  let db;

  // Getter for db reference (used by proxies)
  const getDb = () => db;

  db = {
    // CRUD operations with middleware support
    sub: new Proxy(wrapper.sub, {
      get(target, prop) {
        if (typeof prop === 'symbol') {
          return undefined;
        }
        if (!collectionNamePattern.test(prop)) {
          throw new Error(`"${prop} is not a good collection name"`);
        }
        return target.bind(target, prop);
      }
    }),
    get: createOperationProxy(wrapper.get, 'get', middleware, getDb),
    add: createOperationProxy(wrapper.create, 'add', middleware, getDb),
    set: createOperationProxy(wrapper.replace, 'set', middleware, getDb),
    del: createOperationProxy(wrapper.remove, 'del', middleware, getDb),
    pin: new Proxy(wrapper.cache, {
      get(target, prop) {
        if (typeof prop === 'symbol') {
          return undefined;
        }
        if (!collectionNamePattern.test(prop)) {
          throw new Error(`"${prop} is not a good collection name"`);
        }
        return target.bind(target, prop);
      }
    }),

    // ==================== Transaction API ====================
    // Active transaction ID for this db instance
    _activeTxnId: null,

    // rec() - Start recording, returns txnId AND sets it as active
    rec: () => {
      const txnId = store.rec();
      db._activeTxnId = txnId;
      return txnId;
    },

    // fin(txnId) - Commit transaction, clears active if matching
    fin: (txnId) => {
      txnId = txnId || db._activeTxnId;
      if (!txnId) {
        throw new Error('No transaction to commit');
      }
      return store.fin(txnId).then(result => {
        if (db._activeTxnId === txnId) {
          db._activeTxnId = null;
        }
        return result;
      });
    },

    // nop(txnId) - Cancel transaction, clears active if matching
    nop: (txnId) => {
      txnId = txnId || db._activeTxnId;
      if (!txnId) {
        throw new Error('No transaction to cancel');
      }
      return store.nop(txnId).then(result => {
        if (db._activeTxnId === txnId) {
          db._activeTxnId = null;
        }
        return result;
      });
    },

    // pop(txnId) - Undo last action
    pop: (txnId) => {
      txnId = txnId || db._activeTxnId;
      if (!txnId) {
        throw new Error('No transaction to pop from');
      }
      return store.pop(txnId);
    },

    // txnStatus(txnId) - Get transaction status
    txnStatus: (txnId) => {
      txnId = txnId || db._activeTxnId;
      return store.txnStatus(txnId);
    },

    // ==================== Middleware API ====================
    // Access middleware system for plugins
    middleware: middleware,

    // Convenience method to add middleware
    use: (fn) => {
      middleware.use(fn);
      return db; // chainable
    },

    // ==================== Internal ====================
    // Expose store for advanced operations
    _store: store,

    // Graceful shutdown
    disconnect: () => store.disconnect()
  };

  return db;
}
