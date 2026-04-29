/**
 * @file Middleware-bound operation proxies for db.add / db.set / db.del.
 *
 * Extracted from proxy.js so that file stays under the 260-source-line
 * pre-commit gate. createOperationProxy is identical in behavior — each
 * collection name resolves to a function that builds middleware ctx and
 * delegates to the engine wrapper.
 */

import { collectionNamePattern } from '../engine/constants.js';

/**
 * Build a per-operation proxy for the non-`get` collection verbs.
 *
 * @param {Function} operation - Underlying wrapper method (invoked inside middleware)
 * @param {string} opName - Exactly 'add', 'set', or 'del' (never 'get'; reads use operations-get.js)
 * @param {Object} middleware - Middleware runner from createMiddleware()
 * @param {Function} getDb - Lazy db accessor
 * @returns {Proxy}
 */
export function createOperationProxy(operation, opName, middleware, getDb) {
  return new Proxy(function() {}, {
    /**
     * @param {Function} target
     * @param {string|symbol} prop - Collection name
     * @returns {Function|undefined}
     */
    get(target, prop) {
      if (typeof prop === 'symbol') {
        return undefined;
      }
      if (!collectionNamePattern.test(prop)) {
        throw new Error(`"${prop} is not a good collection name"`);
      }

      return function(...args) {
        const db = getDb();

        const ctx = {
          operation: opName,
          type: prop,
          args: args,
          opts: {},
          db: db,
          result: undefined
        };

        if (opName === 'add' || opName === 'set') {
          const optsArg = args[1];

          if (optsArg && typeof optsArg === 'object') {
            ctx.opts = { ...optsArg };
          }
        }

        return middleware.run(ctx, (ctx) => {
          let finalArgs;

          if (opName === 'add' || opName === 'set') {
            const data = ctx.args[0];
            if (Object.keys(ctx.opts).length > 0) {
              finalArgs = [data, ctx.opts];
            } else {
              finalArgs = [data];
            }
          } else {
            finalArgs = ctx.args;
          }

          return operation.call(operation, prop, ...finalArgs);
        });
      };
    }
  });
}
