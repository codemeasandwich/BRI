/**
 * Middleware System for CRUD Operations
 *
 * Provides a plugin architecture for intercepting and modifying
 * CRUD operations (get, add, set, del) before and after execution.
 *
 * Middleware functions receive context and can:
 * - Modify arguments before operation
 * - Short-circuit and return early
 * - Modify results after operation
 * - Add side effects (logging, caching, etc.)
 */

/**
 * Create a middleware runner
 * @returns {Object} - Middleware manager with use() and run() methods
 */
export function createMiddleware() {
  const middlewares = [];

  return {
    /**
     * Register a middleware function
     * @param {Function} fn - Middleware function(ctx, next)
     *
     * Middleware signature:
     *   async function(ctx, next) {
     *     // ctx.operation = 'get' | 'add' | 'set' | 'del'
     *     // ctx.type = collection type (e.g., 'user', 'userS')
     *     // ctx.args = [data, opts] or [where, opts] depending on operation
     *     // ctx.opts = options object (mutable - can add txnId, etc.)
     *     // ctx.db = db reference
     *     // ctx.result = undefined (set by final handler or middleware)
     *
     *     // Modify ctx.opts before operation
     *     ctx.opts.txnId = ctx.opts.txnId || ctx.db._activeTxnId;
     *
     *     // Call next middleware or final handler
     *     await next();
     *
     *     // Optionally modify ctx.result after operation
     *   }
     */
    use(fn) {
      if (typeof fn !== 'function') {
        throw new Error('Middleware must be a function');
      }
      middlewares.push(fn);
    },

    /**
     * Remove a middleware function
     * @param {Function} fn - Middleware to remove
     */
    remove(fn) {
      const idx = middlewares.indexOf(fn);
      if (idx !== -1) {
        middlewares.splice(idx, 1);
      }
    },

    /**
     * Clear all middleware
     */
    clear() {
      middlewares.length = 0;
    },

    /**
     * Get registered middleware count
     */
    get count() {
      return middlewares.length;
    },

    /**
     * Run middleware chain
     * @param {Object} ctx - Context object
     * @param {Function} finalHandler - Final handler to execute
     * @returns {Promise<any>} - Result from ctx.result
     */
    async run(ctx, finalHandler) {
      let index = 0;

      const next = async () => {
        if (index < middlewares.length) {
          const middleware = middlewares[index++];
          await middleware(ctx, next);
        } else {
          // All middleware executed, run final handler
          ctx.result = await finalHandler(ctx);
        }
      };

      await next();
      return ctx.result;
    }
  };
}

/**
 * Transaction Middleware Plugin
 *
 * Automatically injects active txnId into operations
 * when the db instance has an active transaction.
 *
 * To explicitly bypass the active transaction, pass { txnId: null }
 * or { txnId: false } in opts.
 */
export function transactionMiddleware() {
  return async function txnMiddleware(ctx, next) {
    // If db has active transaction and opts doesn't explicitly set txnId, inject it
    // Note: txnId: null or txnId: false means "don't use transaction"
    if (ctx.db._activeTxnId && !('txnId' in ctx.opts)) {
      ctx.opts.txnId = ctx.db._activeTxnId;
    }
    // Clean up null/false txnId before passing to engine
    if (ctx.opts.txnId === null || ctx.opts.txnId === false) {
      delete ctx.opts.txnId;
    }
    await next();
  };
}

/**
 * Logging Middleware Plugin (example)
 *
 * Logs all CRUD operations for debugging.
 */
export function loggingMiddleware(options = {}) {
  const { prefix = '[BRI]', logResults = false } = options;

  return async function logMiddleware(ctx, next) {
    const start = Date.now();
    console.log(`${prefix} ${ctx.operation}.${ctx.type}`, ctx.args);

    await next();

    const duration = Date.now() - start;
    if (logResults) {
      console.log(`${prefix} ${ctx.operation}.${ctx.type} completed in ${duration}ms`, ctx.result);
    } else {
      console.log(`${prefix} ${ctx.operation}.${ctx.type} completed in ${duration}ms`);
    }
  };
}

/**
 * Validation Middleware Plugin (example)
 *
 * Validates data before create/update operations.
 */
export function validationMiddleware(validators = {}) {
  return async function validateMiddleware(ctx, next) {
    if (ctx.operation === 'add' || ctx.operation === 'set') {
      const validator = validators[ctx.type] || validators['*'];
      if (validator) {
        const data = ctx.args[0];
        const errors = await validator(data, ctx);
        if (errors && errors.length > 0) {
          throw new Error(`Validation failed for ${ctx.type}: ${errors.join(', ')}`);
        }
      }
    }
    await next();
  };
}

/**
 * Hooks Middleware Plugin
 *
 * Provides before/after hooks for specific operations and types.
 */
export function hooksMiddleware() {
  const hooks = {
    before: new Map(),
    after: new Map()
  };

  const middleware = async function hooksMiddleware(ctx, next) {
    // Run before hooks
    const beforeKey = `${ctx.operation}:${ctx.type}`;
    const beforeAll = `${ctx.operation}:*`;

    for (const key of [beforeAll, beforeKey]) {
      const beforeHooks = hooks.before.get(key) || [];
      for (const hook of beforeHooks) {
        await hook(ctx);
      }
    }

    await next();

    // Run after hooks
    const afterKey = `${ctx.operation}:${ctx.type}`;
    const afterAll = `${ctx.operation}:*`;

    for (const key of [afterAll, afterKey]) {
      const afterHooks = hooks.after.get(key) || [];
      for (const hook of afterHooks) {
        await hook(ctx);
      }
    }
  };

  // Attach hook registration methods
  middleware.before = (operation, type, fn) => {
    const key = `${operation}:${type}`;
    if (!hooks.before.has(key)) {
      hooks.before.set(key, []);
    }
    hooks.before.get(key).push(fn);
  };

  middleware.after = (operation, type, fn) => {
    const key = `${operation}:${type}`;
    if (!hooks.after.has(key)) {
      hooks.after.set(key, []);
    }
    hooks.after.get(key).push(fn);
  };

  return middleware;
}
