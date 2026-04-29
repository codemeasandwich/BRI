## Directory Structure

```
client/
├── index.js
├── proxy.js
├── proxy-operations.js
├── query-builder.js
├── query-builder-residual.js
├── query-builder-vector-exec.js
├── query-builder-where-exec.js
├── query-builder-terminals.js
├── grouped-query-builder.js
├── match-engine.js
└── txn-lifecycle.js
```

## Files

### `index.js`

Database factory and singleton management.

**Exports:**
- `createDB(options)` - Create new database instance
- `getDB(options)` - Get or create singleton instance
- `default` - Alias for createDB

**Options:**
- `storeType` - Storage backend ('inhouse')
- `storeConfig` - Storage configuration object

### `proxy-operations.js`

Per-operation Proxy factory for `db.add`, `db.set`, `db.del` — constructs the middleware ctx, forwards opts, invokes the engine wrapper under `middleware.run`.

**Exports:**
- `createOperationProxy(operation, opName, middleware, getDb)` - Returns collection-name → callable proxies

### `query-builder-residual.js`

Layers planner residual filters with supersession/confidence/graph-touching gates; `decorateResults` for `$provenance` and `_field` hydrates; `touchingCandidateIds` for GraphIndex adjacency.

**Exports:**
- `composeResidualFilter`, `decorateResults`, `touchingCandidateIds`

### `query-builder-vector-exec.js`

`attachScore` and `executeVectorPlan` — the `.near` execution path (index-bounded, full-scan, txn merge, efSearch forward).

**Exports:**
- `attachScore`, `executeVectorPlan`

### `query-builder-where-exec.js`

`executeWherePlan` — `.where`-only scans (secondary-index candidate hydration or full collection + residual predicate).

**Exports:**
- `executeWherePlan`

### `query-builder-terminals.js`

Terminal helpers: `queryBuilderFirst`, `queryBuilderCount`, `queryBuilderDistinct` (`.near` composition guards for count/distinct).

**Exports:**
- `queryBuilderFirst`, `queryBuilderCount`, `queryBuilderDistinct`

### `proxy.js`

Proxy-based API handlers with middleware integration.

**Exports:**
- `createDBInterface(wrapper, store)` - Create public DB interface

**Interface Methods:**
- `db.sub.<type>(callback)` - Subscribe to changes
- `db.get.<type>(where?, opts?)` - Get documents (legacy callable form)
- `db.get.<type>S.where(...).near(...)` - Chainable query builder (group form only)
- `db.add.<type>(data, opts?)` - Create document
- `db.set.<type>(data, opts?)` - Replace document
- `db.del.<type>($ID, deletedBy?)` - Delete document
- `db.pin.<type>(key, val, expire)` - Cache value
- `db.schema(collection, schemaDef)` - Register a schema; auto-instantiates vector index if schema declares a vector field
- `db.cascade.{scope}(id, opts?)` - Schema-scoped bulk delete (UC-X2); operates only on collections that declared a field with cascadeOn for the matching scope. `db.cascade.byField({collections, filter})` is the explicit-list escape hatch.
- `db.algo.degree({collection, via, weighted?, top?})` - Degree centrality over a registered edge collection (UC-G5). PPR scoped for v3.
- `entity.expand({via, hops, budget, predicates, direction, edgeFilter})` - Parameterized BFS from the entity (UC-G6); see graph.md.

**Transaction Methods:**
- `db.rec()` - Start transaction, returns txnId
- `db.fin(txnId?)` - Commit transaction
- `db.nop(txnId?)` - Cancel transaction
- `db.pop(txnId?)` - Undo last action
- `db.txnStatus(txnId?)` - Get status

**Middleware Methods:**
- `db.use(fn)` - Register middleware
- `db.middleware` - Access middleware runner

**Internal:**
- `db._activeTxnId` - Current transaction ID
- `db._store` - Storage adapter reference
- `db._registry` - Schema registry instance (for advanced introspection)
- `db.disconnect()` - Graceful shutdown

### `txn-lifecycle.js`

Transaction lifecycle bindings (rec/fin/nop/pop/txnStatus) for the public db interface. Bridges the storage-layer transaction lifecycle to the schema registry's vector indexes — fin flushes each index's pending bucket via index.commit(txnId), nop calls rollback, and pop targets popStaged on the matching collection's index when the popped action was a SET on a vector-bearing $ID.

**Exports:**
- `createTxnLifecycle(store, registry, getDb)` - Returns `{rec, fin, nop, pop, txnStatus}` for spread into the db interface
- `default` - Same as createTxnLifecycle

### `query-builder.js`

Chainable query builder used by the new `db.get.{collection}S.where(...).near(...)` surface. Immutable per-link chain (each chain method returns a new builder). Composes attribute filters with vector search by feeding `.where` predicates into the `VectorIndex.searchFiltered` traversal so filtering happens before k-truncation. Honors active transactions: when `db._activeTxnId` is set, `.near` calls `searchInTxn` (committed + pending merge) and propagates `txnId` to hydration. `.near` accepts an optional opts object (`{txnId: null}` to force-bypass the active txn, `{txnId: '<id>'}` to target a specific txn) for advanced query routing. `.count()`, `.distinct(field)`, and `.groupBy(field)` (UC-X3) provide aggregation primitives; the GroupedQueryBuilder it returns supports `.count()`, `.sum(field)`, `.having(filter)` with the shared filter compiler.

**Exports:**
- `QueryBuilder` class - chain methods: `where`, `near`, `match`, `combine`, `limit`, `toArray`, `first`, `count`, `distinct`, `groupBy`; thenable so `await builder` works.
- `default` - Same as QueryBuilder

### `grouped-query-builder.js`

GroupedQueryBuilder produced by `QueryBuilder.groupBy(field)`. Supports `.count()` / `.sum(field)` aggregation terminals plus `.having(filter)` post-aggregation filter (uses the same shared `compileFilter` so $gte / $in etc. work on the synthesized count/sum field). Thenable so `await builder.groupBy('x').count()` resolves to grouped rows directly.

**Exports:**
- `GroupedQueryBuilder` class - chain methods: `count`, `sum`, `having`, `toArray`; thenable
- `default` - Same as GroupedQueryBuilder

### `match-engine.js`

Substring-FTS scan + weighted-blend execution helpers (UC-X4 / UC-V3). Backs the `.match()` and `.combine()` chain methods on `QueryBuilder`. Two free functions — `executeMatch` for `.match`-only chains (binary substring score + recency tiebreak + `$matchHits` attribution) and `executeCombined` for `.match` + `.near` + `.combine` chains (blended `weights.alias * matchScore + weights.vector * cosine` with `$score` / `$cosine` / `$matchHits` audit trail; honors `null_embedding_eligible_via_alias` by treating missing embeddings as `cosine = 0`). Extracted from query-builder.js to keep that file under the 260-source-line gate AND to isolate the v2 scoring expansion target (TF-IDF, fuzzy match, persistent FTS index) from the chain ergonomics.

**Exports:**
- `executeMatch({plan, match, limit, collection, wrapper})` - `.match`-only execution
- `executeCombined({plan, match, near, weights, limit, collection, registry, wrapper})` - blended execution
