/**
 * @file Client proxy handlers — the user-facing routing layer.
 *
 * Builds the db.get / db.add / db.set / db.del / db.sub / db.pin namespaces
 * over the engine wrapper, plus the higher-level surfaces (db.schema,
 * db.cascade, db.algo, db.use, db.middleware, db.rec/fin/nop/pop). This is
 * the file that determines what syntax users see; the engine wrapper
 * underneath sees no Proxy magic.
 *
 * Role in the system:
 *   - Sits between the user code and the engine wrapper. Adds:
 *       1. CRUD-by-collection-name routing (`db.add.{collection}` etc.)
 *       2. The middleware chain (validation, txn injection, vector + graph
 *          + secondary index sync)
 *       3. The hybrid get-proxy (legacy callable + new chainable builder)
 *       4. The schema registry binding so the proxy can route predicate
 *          access on reactive entities through to the engine
 *       5. Lifecycle bindings (rec/fin/nop/pop) wired through txn-lifecycle
 *
 * Dependencies (what this relies on):
 *   - engine/constants.js          → collectionNamePattern (rejects bad names)
 *   - engine/middleware.js         → createMiddleware + transactionMiddleware
 *   - engine/schema-registry.js    → createSchemaRegistry (vector + secondary +
 *                                    graph + cascade + lifecycle state)
 *   - engine/vector-middleware.js  → vectorIndexMiddleware (sync indexes on
 *                                    add/set/del; pre-fetches old docs for
 *                                    edge / secondary-index removals)
 *   - engine/cascade.js            → createCascade (db.cascade.{scope})
 *   - engine/graph-algo.js         → createAlgo (db.algo.degree, future PPR)
 *   - client/query-builder.js      → QueryBuilder (chainable .where/.near/...)
 *   - client/txn-lifecycle.js      → createTxnLifecycle (rec/fin/nop/pop with
 *                                    vector-index commit/rollback hooks)
 *
 * Consumers (what relies on this):
 *   - client/index.js              → createDB calls createDBInterface to build
 *                                    the user-facing db object
 *
 * Hybrid get-proxy mechanics:
 *   - `db.get.user('USER_x')`        → legacy single-fetch (function call)
 *   - `db.get.userS()`               → legacy group fetch (preserved)
 *   - `db.get.userS.where(...)`      → chainable QueryBuilder (new)
 *   - `db.get.userS.near(vec, k)`    → chainable QueryBuilder (new)
 *
 * Implementation: an inner Proxy over the legacy callable. The Proxy
 * intercepts property access to detect chainable method names — when the
 * accessed name is in CHAIN_METHODS, a builder is allocated lazily and
 * the requested method is bound to it. apply() on the same proxy preserves
 * the legacy invocation form. Unknown property names return undefined so
 * non-chain accesses don't accidentally allocate builders.
 *
 * Adding a new chain method:
 *   1. Add the method to QueryBuilder (or a sibling like GroupedQueryBuilder
 *      / match-engine).
 *   2. Add the method's name string to CHAIN_METHODS below.
 *   3. Confirm it doesn't collide with the schema-author-facing reserved
 *      list (engine/schema-edge-declare.js → RESERVED_PROXY_NAMES) — adding
 *      to the reserved list is a breaking change requiring a major bump.
 *
 * Predicate proxy on reactive entities:
 *   The wrapper returned by createEngine is decorated here with
 *   `_registry` and `_getDb` so engine/reactive.js can route entity property
 *   access through engine/predicate-proxy.js. The decoration is one-way —
 *   wrapper consumers see the additions; the reactive layer reads them but
 *   does not depend on the client/ folder.
 */

import { collectionNamePattern } from '../engine/constants.js';
import { createMiddleware, transactionMiddleware } from '../engine/middleware.js';
import { createSchemaRegistry } from '../engine/schema-registry.js';
import { vectorIndexMiddleware } from '../engine/vector-middleware.js';
import { createCascade } from '../engine/cascade.js';
import { createAlgo } from '../engine/graph-algo.js';
import { QueryBuilder } from './query-builder.js';
import { createTxnLifecycle } from './txn-lifecycle.js';

/**
 * Create a proxy handler that intercepts collection access
 * and runs operations through the middleware system.
 *
 * @param {Function} operation - The underlying operation (get, create, etc.)
 * @param {string} opName - Operation name ('get', 'add', 'set', 'del')
 * @param {Object} middleware - Middleware runner
 * @param {Function} getDb - Function to get db reference
 */
/**
 * Build a per-operation proxy for non-get verbs (add/set/del/sub/pin).
 *
 * @param {Function} operation - Underlying engine wrapper method
 * @param {string} opName - Operation tag ('add' | 'set' | 'del')
 * @param {Object} middleware - Middleware runner from createMiddleware()
 * @param {Function} getDb - Returns the resolved db reference (closure-bound)
 * @returns {Proxy}
 */
function createOperationProxy(operation, opName, middleware, getDb) {
  return new Proxy(function() {}, {
    /**
     * Proxy get trap: returns a per-collection callable for the operation.
     * @param {Function} target - Underlying empty function (proxy target)
     * @param {string|symbol} prop - Collection name accessed on the proxy
     * @returns {Function|undefined}
     */
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
 * Create a hybrid get-proxy that keeps the legacy callable API while also
 * exposing the new chainable QueryBuilder for group reads.
 *
 * Behavior:
 *   - `db.get.user('USER_x')`        : legacy single-fetch (function call)
 *   - `db.get.userS()`               : legacy group fetch
 *   - `db.get.userS.where(...)`      : NEW — returns QueryBuilder
 *   - `db.get.userS.near(vec, k)`    : NEW — returns QueryBuilder
 *
 * Implementation: the inner per-collection proxy is itself a Proxy over the
 * legacy callable. The Proxy intercepts property access to detect chainable
 * method names (where, near, limit, then, toArray, first) and constructs a
 * QueryBuilder lazily. apply() preserves legacy invocation.
 *
 * Why lazy: a builder allocates on first chain access, not on bare property
 * access — keeps the legacy callable cheap and the chainable surface
 * discoverable via a single fixed list of method names.
 *
 * @param {Object} wrapper  - Engine wrapper (for hydration)
 * @param {Object} registry - Schema registry (for vector index lookup)
 * @param {Object} middleware - Middleware runner (for legacy invocation)
 * @param {Function} getDb  - db reference accessor
 * @returns {Proxy}
 */
function createGetProxy(wrapper, registry, middleware, getDb) {
  // Names that should construct a QueryBuilder when accessed on a group
  // collection (one ending with 'S'). This is the only chainable surface.
  /*
   * Names that should construct a QueryBuilder when accessed on a group
   * collection (one ending with 'S'). This is the only chainable surface;
   * any other property access on the group proxy returns undefined so we
   * don't accidentally allocate a builder for unrelated reads.
   *
   * Each entry must:
   *   - exist on QueryBuilder (or be threaded through to a sibling like
   *     GroupedQueryBuilder / match-engine via QueryBuilder method)
   *   - NOT collide with the schema-author-facing reserved list
   *     (engine/schema-edge-declare.js → RESERVED_PROXY_NAMES) — that list
   *     governs predicate names; this list governs collection-level chain
   *     methods. They overlap deliberately because the builder and the
   *     predicate proxy share the same chain ergonomics.
   *
   * Routing matrix per implementation: see toArray() in query-builder.js
   * and the executeMatch / executeCombined helpers in match-engine.js.
   */
  const CHAIN_METHODS = new Set([
    'where', 'near', 'limit', 'toArray', 'first', 'then',
    'count', 'distinct', 'groupBy',
    'match', 'combine'
  ]);

  return new Proxy(function() {}, {
    /**
     * Outer get trap: returns either a legacy callable (singular form,
     * collection name without trailing 'S') or a hybrid callable+chainable
     * proxy (group form, collection name ending in 'S').
     * @param {Function} target - Underlying empty function (proxy target)
     * @param {string|symbol} prop - Collection name accessed on db.get
     * @returns {Function|Proxy|undefined}
     */
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (!collectionNamePattern.test(prop)) {
        throw new Error(`"${prop} is not a good collection name"`);
      }

      const isGroup = prop.endsWith('S');
      // Strip trailing S to derive the underlying collection name. The
      // engine consumes both forms but the schema registry only knows the
      // singular form (memoryArtifact, not memoryArtifactS).
      const collection = isGroup ? prop.slice(0, -1) : prop;

      // Build the legacy callable that .userS(...) invokes (preserves shape).
      const legacyCallable = function(...args) {
        const db = getDb();
        const ctx = {
          operation: 'get', type: prop, args, opts: {}, db, result: undefined
        };
        const where = args[0];
        const explicitOpts = args[1];
        if (explicitOpts && typeof explicitOpts === 'object') {
          ctx.opts = { ...explicitOpts };
        } else if (where && typeof where === 'object' && 'txnId' in where && !where.$ID) {
          ctx.opts = { ...where };
          ctx.args = [undefined, ctx.opts];
        }
        return middleware.run(ctx, (ctx) => {
          let finalArgs;
          const w = ctx.args[0];
          if (Object.keys(ctx.opts).length > 0) finalArgs = [w, ctx.opts];
          else finalArgs = [w];
          return wrapper.get(prop, ...finalArgs);
        });
      };

      // For non-group collections (db.get.user), only the callable form is
      // ever used. Return the legacy callable directly.
      if (!isGroup) return legacyCallable;

      // Group collection: wrap the callable so chain methods trigger a
      // builder. Property access for chain methods returns a bound builder
      // method; everything else returns whatever the underlying callable
      // exposes (mostly nothing).
      return new Proxy(legacyCallable, {
        /**
         * Property-access trap: routes chain-method names to a fresh
         * QueryBuilder bound to this collection.
         * @param {Function} _t - Underlying callable (legacy form)
         * @param {string|symbol} builderProp - Property name accessed
         * @returns {Function|undefined}
         */
        get(_t, builderProp) {
          if (typeof builderProp === 'symbol') return undefined;
          if (!CHAIN_METHODS.has(builderProp)) return undefined;
          // Lazily construct a builder; the chain method on it is what the
          // caller actually wanted.
          const builder = new QueryBuilder({
            collection, wrapper, registry, getDb
          });
          return builder[builderProp].bind(builder);
        },
        /**
         * Apply trap: invoking the proxy with parens preserves the legacy
         * group-call semantics.
         * @param {Function} _t - Underlying callable
         * @param {*} _thisArg - Ignored
         * @param {Array} args - Forwarded to the legacy callable
         * @returns {Promise}
         */
        apply(_t, _thisArg, args) {
          return legacyCallable(...args);
        }
      });
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
  // Schema registry for vector indexes and validation. Store reference
  // enables reuse of persisted indices loaded from snapshot during recovery.
  const registry = createSchemaRegistry(store);
  // Make the registry visible to the engine's reactive proxy so it can
  // route predicate property access through resolvePredicateAccess.
  // (Lower-layer, per the existing wrapper convention of internal _underscore fields.)
  wrapper._registry = registry;
  // Late-bound db accessor for the predicate proxy: writes go through
  // db.add.{collection} so middleware (validation, vector + graph sync)
  // fires the same way it does for direct user calls. The accessor is a
  // function so it captures the db reference even though it's assigned
  // below this line.
  wrapper._getDb = () => db;

  // Register default transaction middleware
  middleware.use(transactionMiddleware());
  // Register vector-index sync middleware. Runs after txn middleware so
  // ctx.opts.txnId is already populated when we observe the operation.
  middleware.use(vectorIndexMiddleware(registry));

  // The db object (we need a reference for middleware context)
  let db;

  /**
   * Late-bound db accessor used by proxy traps that need to consult ctx.db.
   * @returns {Object} the db interface (resolved lazily after assignment)
   */
  const getDb = () => db;

  db = {
    // CRUD operations with middleware support
    sub: new Proxy(wrapper.sub, {
      /**
       * Bind subscribe operations to a specific collection name.
       * @param {Function} target - wrapper.sub
       * @param {string|symbol} prop - collection name
       * @returns {Function|undefined}
       */
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
    get: createGetProxy(wrapper, registry, middleware, getDb),
    add: createOperationProxy(wrapper.create, 'add', middleware, getDb),
    set: createOperationProxy(wrapper.replace, 'set', middleware, getDb),
    del: createOperationProxy(wrapper.remove, 'del', middleware, getDb),
    pin: new Proxy(wrapper.cache, {
      /**
       * Bind cache operations to a specific collection name.
       * @param {Function} target - wrapper.cache
       * @param {string|symbol} prop - collection name
       * @returns {Function|undefined}
       */
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
    // Active transaction ID for this db instance — read by middleware to
    // auto-inject txnId into ctx.opts and by lifecycle hooks to clear on fin/nop.
    _activeTxnId: null,

    // Lifecycle methods (rec/fin/nop/pop/txnStatus) are spread in below from
    // createTxnLifecycle to keep this file focused on routing + proxies.
    ...createTxnLifecycle(store, registry, getDb),

    // ==================== Schema Registry ====================
    /**
     * Register a schema for a collection.
     *
     * Declaring a schema with a vector field auto-instantiates the per-
     * collection VectorIndex and arms the indexing middleware so that
     * subsequent add/set/del operations stay in sync.
     *
     * @param {string} collection
     * @param {Object} schemaDef
     * @returns {Object} db (chainable)
     */
    schema: (collection, schemaDef) => {
      registry.declare(collection, schemaDef);
      return db;
    },

    // ==================== Cascade API (UC-X2) ====================
    // db.cascade.{scope}(id, opts?) — schema-scoped bulk delete that
    // operates on collections opted-in via cascadeOn. The proxy here
    // routes any property access (other than .byField) to a runner for
    // that scope. Per §10 this surface is non-negotiable; collections
    // without the matching cascadeOn flag stay invisible to it.
    cascade: createCascade({ registry, getDb }),

    // ==================== Graph algorithms (UC-G5) ====================
    // db.algo.{name}(args) — parameterized graph algorithms over registered
    // edge collections. v1 ships degree centrality; PPR is scoped for v3.
    algo: createAlgo({ registry, getDb }),

    // Expose registry for advanced introspection (vector index stats, etc.)
    _registry: registry,

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
