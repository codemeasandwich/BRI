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
 *   - client/proxy-operations.js → createOperationProxy (extracted line-count)
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
import { createOperationProxy } from './proxy-operations.js';
import { createTxnLifecycle } from './txn-lifecycle.js';

/**
 * Create a hybrid get-proxy: keeps the legacy callable API for backwards
 * compatibility AND exposes the chainable QueryBuilder for new code.
 * This is the user-facing surface for `db.get.{collection}` access.
 *
 * Why hybrid: the project has existing tests / consumers calling
 * `db.get.userS()` with parens; adding a chainable replacement that
 * broke them would force every downstream caller to migrate. The
 * Proxy here intercepts BOTH property access (returns a chain method
 * bound to a fresh QueryBuilder) and apply (calls the legacy callable),
 * so the same `db.get.userS` symbol supports both forms.
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
    'match', 'combine',
    // Spec §2.2 chain-method completion (see client/query-builder.js):
    'touching', 'hydrate', 'confidence',
    'history', 'withProvenance', 'asOf'
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
          // Spec §2.2 marks `history` and `withProvenance` as PROPERTY
          // accessors — getters that return a derived builder. Functions
          // need .bind; getters return a builder that we forward as-is.
          // Detect by reading the property value on the prototype: a
          // getter-defined property's descriptor has `get`; a regular
          // method is a plain function on the value.
          const proto = Object.getPrototypeOf(builder);
          const desc = Object.getOwnPropertyDescriptor(proto, builderProp);
          if (desc && typeof desc.get === 'function') {
            return builder[builderProp];
          }
          const m = builder[builderProp];
          return m.bind(builder);
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
 * Build the public db interface — the one user code interacts with.
 *
 * Composition order matters here:
 *   1. Construct the middleware runner; bind transactionMiddleware first
 *      so subsequent middleware sees the active txnId on ctx.opts.
 *   2. Construct the schema registry, passing the store so persisted
 *      vector indices and secondary-index state load on first declare().
 *   3. Decorate the wrapper with `_registry` and `_getDb` so the engine's
 *      reactive proxy (engine/reactive.js) can route predicate property
 *      access through engine/predicate-proxy.js. This is one-way: the
 *      engine reads these fields but doesn't depend on the client folder.
 *   4. Bind vectorIndexMiddleware AFTER transactionMiddleware so it sees
 *      ctx.opts.txnId already populated; without this order, edge writes
 *      inside a transaction would route through the committed-index path.
 *   5. Construct each user-facing namespace — sub / get / add / set / del /
 *      pin / cascade / algo / schema / use / middleware / rec-fin-nop-pop —
 *      and assemble them into the db object.
 *   6. Spread createTxnLifecycle's bindings so `db.fin/nop/pop` know how to
 *      flush / rollback / pop the schema-registry's vector indices in lock
 *      step with the storage transaction.
 *
 * Why the registry holds vectorIndices but the storage adapter holds
 * vectorEntries: the registry is the runtime owner; the storage layer
 * just persists serialized snapshots. The registry's declare() asks the
 * store for any cached entry on a known collection, validates against
 * drift, and registers the live VectorIndex with the store so the next
 * snapshot serializes it. See engine/schema-registry.js for the protocol.
 *
 * @param {Object} wrapper - Engine wrapper produced by createEngine(store);
 *   provides sub / create / update / replace / cache / get / remove
 * @param {Object} store - Storage adapter (currently the InHouseAdapter);
 *   used by the registry for persistence-aware declares and by the
 *   txn lifecycle bindings for rec / fin / nop / pop / txnStatus
 * @returns {Object} The public db interface — passed to createDB callers
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
    // Optional sessionId attached at db.rec({sessionId}) — read by
    // db.cascade.session(id) to identify and cancel an in-flight txn that
    // belongs to the cancelled session before sweeping committed state
    // (spec §2.8 / non-negotiable §0.3 #5).
    _activeTxnSessionId: null,

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
