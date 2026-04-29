## Directory Structure

```
engine/
├── index.js
├── constants.js
├── id.js
├── types.js
├── helpers.js
├── operations.js
├── operations-get.js
├── operations-remove.js
├── reactive.js
├── middleware.js
├── schema-registry.js
├── secondary-index.js
├── query-planner.js
├── filter-compiler.js
├── graph-index.js
├── graph-expand.js
├── graph-algo.js
├── chain-walk.js
├── predicate-inverse-related.js
├── predicate-proxy.js
├── schema-edge-declare.js
├── cascade.js
├── vector-index.js
├── vector-index-codec.js
├── vector-index-hnsw.js
├── vector-index-hnsw-state.js
├── vector-index-rng.js
├── vector-index-txn.js
├── vector-middleware.js
└── errors.js
```

## Files

### `index.js`

Engine factory creating operation wrappers.

**Exports:**
- `createEngine(store)` — Create engine instance
- `VectorIndex`, `GraphIndex` — Optional advanced constructors for benchmarking, deterministic txn-buffer assertions, or extensions (applications normally use vectors/graphs via `createDB().schema(...)` instead)
- `export * from './errors.js'` — BriError hierarchy and error-code constants (same module path `engine/errors.js` used throughout the codebase)
- Re-exports from constants, helpers, types, reactive

### `constants.js`

Shared constants and symbols.

- `collectionNamePattern` - Regex for valid collection names. Accepts alphanumeric identifiers (camelCase allowed in the interior) starting with a lowercase letter or digit, never ending in lowercase 's', optionally suffixed with capital 'S' for the group accessor.
- `undeclared` - Symbol for deleted/missing values
- `MAKE_COPY` - Symbol for creating proxy copies

### `id.js`

ID generation utilities.

- `createIdGenerator(store)` - Returns { genid, makeid, idIsFree }
- Uses Crockford base32 (excludes confusing chars like l, i, o)

### `types.js`

Type utilities and change publishing.

- `type2Short(type)` - Convert "user" or "userS" to "USER"
- `createPublisher(store, genid)` - Create publish function

### `helpers.js`

Helper utilities for object manipulation.

- `stripDown$ID(obj)` - Convert nested objects to ID references
- `attachToString(obj)` - Attach toString() returning $ID
- `checkMatch(subset, source)` - Partial object matching
- `buildOverlayObject(changes, source)` - Apply changes
- `isMatch(query, input)` - Deep equality check

### `operations.js`

Core CRUD operations factory.

**Methods:**
- `sub(type, cb)` - Subscribe to type changes
- `create(type, data, opts)` - Create new document
- `update(target, changes, opts)` - Apply changes
- `replace(type, data, opts)` - Replace entire document
- `get` - Injected from operations-get.js
- `remove` - Injected from operations-remove.js

### `operations-get.js`

Get operation with filtering and population.

- Single item by ID or query object
- Collection with filter (object or function)
- Population of nested references

### `operations-remove.js`

Remove operation with soft-delete support.

- Soft delete (rename to X:key:X pattern)
- Removes from collection index
- Publishes DELETE event

### `reactive.js`

Reactive proxy for change tracking.

- `watchForChanges({ wrapper, populate, txnId }, obj)` - Wrap in proxy
- Tracks all property changes
- Provides .save(), .and, .toJSON()

### `middleware.js`

Middleware plugin system.

**Exports:**
- `createMiddleware()` - Create middleware runner
- `transactionMiddleware()` - Auto-inject active txnId
- `loggingMiddleware(opts)` - Log all operations
- `validationMiddleware(validators)` - Validate on write
- `hooksMiddleware()` - Before/after hooks

### `schema-registry.js`

Per-database schema registry. Holds schemas declared via `db.schema('name', def)` and instantiates the per-collection VectorIndex when a schema declares a vector field. On startup, consults the storage adapter's persisted vector entries (loaded from snapshot during recovery) and reuses the deserialized index when present, or creates a fresh one otherwise. Validates dims/metric/field drift against persisted state and refuses incompatible re-declarations with a diagnostic error. Single source of truth for schema-driven features (validation, vector indexing, future secondary indexes / refs / cascade scopes).

**Exports:**
- `createSchemaRegistry(store)` - Returns registry with `declare`, `get`, `vectorIndex`, `vectorFieldOf`, `validate`, `secondaryIndexManager`, `vectorIndices`, `graphIndex`, `edgeSpec`, `collectionForPrefix`, `predicateEdge`, `inversePredicateEdge`, `predicatesForSubject`, `cascadeEntriesFor`, `lifecycleFieldsOf`. Reserved-name collision check fires at `declare` time when a `$edge.predicates` entry collides with the frozen proxy-method list. `cascadeOn`-flagged fields and `$supersession`/`$confidence`/`$provenance` flags are registered for `db.cascade` and the predicate proxy's chain methods respectively; `$`-flag values are validated against declared field names so a typo throws at schema load instead of silently filtering nothing. The optional `store` argument enables persistence-aware declares.

### `vector-index.js`

In-process vector index for k-NN search (v2). Slim wrapper class — owns slot storage (`Float32Array`, `_idAt`, `_slotOf`, free-list) and the public interface (`add`, `remove`, `search`, `searchFiltered`, `stats`, `serialize`, static `deserialize`). Search/insert delegate to the HNSW algorithm in `vector-index-hnsw.js`; transactions delegate to `vector-index-txn.js`. Constructor accepts HNSW parameters `{M, efConstruction, efSearch, seed}` (spec §3.1 defaults: 16 / 200 / 50). Per-call `opts.efSearch` override on `search` / `searchFiltered` / `searchInTxn`. `static deserialize(buf)` accepts both v1 (no graph topology — triggers a one-shot HNSW rebuild from slot storage on boot) and v2 (topology installed directly) wire formats.

**Exports:**
- `VectorIndex` class - One instance per vector-bearing collection
- `default` - Same as VectorIndex

### `vector-index-codec.js`

Binary codec for VectorIndex — magic + version constants, the cosine helper, and `packIndex` / `unpackIndex` free functions that materialize the wire format. v2 appends an HNSW topology section after the v1 payload (M / efConstruction / efSearch / entryPoint / entryLevel / per-slot levels / sparse neighbour blocks). v1 buffers are still readable; the wrapper detects them and rebuilds the HNSW graph at deserialize time.

**Exports:**
- `cosine(a, b)` - similarity helper
- `packIndex(index)` - serialize a VectorIndex to a Buffer
- `unpackIndex(buf)` - decode a Buffer into VectorIndex internal state (returns `{... version, hnsw}`; `hnsw` is null for v1 payloads)
- `SERIALIZATION_MAGIC`, `SERIALIZATION_FORMAT_VERSION` (= 2), `SERIALIZATION_FORMAT_VERSION_V1`

### `vector-index-hnsw.js`

Pure-JS HNSW algorithm core. `searchLayer(index, query, ep, ef, layer, predicate?)` runs the layer-bounded best-first search (Malkov & Yashunin §4 Algorithm 2, adapted to similarity); the predicate gates inclusion in the result set but NOT graph traversal so a filtered-out candidate can still bridge to additional accepting candidates (UC-V1 acceptance criterion 3). `selectNeighborsHeuristic` implements the §4 Algorithm 4 spread-direction selector that prevents single-direction clustering. `insertNode(index, slot)` runs the full insert: pickLevel → greedy descent → wide search-and-link with bidirectional pruning → entry-point promotion. `searchHNSW` is the top-level query entry point — greedy descent through upper layers, wide search at level 0, sort + truncate to k. `effectiveEf = max(ef, k)` so callers asking for more than the default frontier always get them, and small fixtures get exact-recall behaviour for free.

**Exports:**
- `searchLayer`, `selectNeighborsHeuristic`, `insertNode`, `searchHNSW`

### `vector-index-hnsw-state.js`

Topology lifecycle helpers — `ensureTopology` (alloc/grow per-slot level table + neighbour-list array), `dropNode` (lazy delete: clear lists + re-elect entry point if needed), `rebuildTopology` (re-insert every populated slot — used when deserializing a v1-format snapshot, logged at INFO so operators see the one-shot upgrade event). Separated from the algorithmic core so each file stays at or under the 200-NCLOC ceiling.

**Exports:**
- `ensureTopology`, `dropNode`, `rebuildTopology`

### `vector-index-rng.js`

Seedable Mulberry32 PRNG + `pickLevel(rng, M)` for HNSW level assignment. Determinism contract: `makeRng(seed)` with the same integer seed produces an identical output stream across runs, processes, and Node versions — required for tests that assert bit-equality of serialize() output across two freshly-constructed indexes. Without a seed, falls through to `Math.random() * 2^32` (production default). The VectorIndex constructor reads `BRI_VECTOR_RNG_SEED` from env when no `{seed}` opt is supplied, so operators / tests can pin determinism without per-call plumbing.

**Exports:**
- `makeRng(seed?)` - Returns a deterministic `() => [0,1)` closure
- `pickLevel(rng, M)` - Geometric draw for HNSW level assignment

### `vector-index-txn.js`

Per-transaction deferred-linking buffer for the vector index (spec §7.1). `_pending` is a `Map<txnId, Array<{op,id,vec}>>` on the index instance; `stageAdd` / `stageRemove` append; `commitTxn` flushes via callbacks back to the wrapper's add/remove (so HNSW topology mutations go through the same path as non-txn writes); `rollbackTxn` drops the bucket; `popStagedOp` walks the bucket back-to-front; `searchInTxnMerged` runs a wider committed search and merges the pending log. The merge algorithm is independent of the underlying data structure — it scores pending vectors with the shared cosine helper and applies stagedRemoves as a predicate-time exclusion. Extracted from vector-index.js so the wrapper class stays under the 200-NCLOC ceiling.

**Exports:**
- `stageAdd`, `stageRemove`, `commitTxn`, `rollbackTxn`, `popStagedOp`, `searchInTxnMerged`

### `vector-middleware.js`

Middleware that keeps the per-collection VectorIndex, any declared secondary indexes, AND the GraphIndex in sync with add/set/del operations and enforces schemas registered through the registry. Validation runs before next() (invalid writes short-circuit before storage); index sync runs after next() (so ctx.result.$ID is populated). For set/del on collections with secondary indexes or edge collections, the middleware pre-fetches the old document so SortedIndex.update and GraphIndex.removeEdge can target the OLD field values before applying the NEW. When `ctx.opts.txnId` is set, vector writes route through `addStaged` / `removeStaged` so the committed index buffer is never touched until `db.fin()` flushes the pending bucket.

**Exports:**
- `vectorIndexMiddleware(registry)` - Returns the middleware function
- `default` - Same as vectorIndexMiddleware

### `secondary-index.js`

Schema-declared compound indexes used to bound `.where` lookups. `SortedIndex` holds parallel arrays of (sortedKey, ids[]) entries with binary-search lookup; `SecondaryIndexManager` owns one or more SortedIndex instances per collection, routes write/lookup calls, and computes the best-fit candidate set for a filter via `candidatesFor(collection, filter)`. Persisted as POJO inside snapshot v3.

**Exports:**
- `SecondaryIndexManager` (default) - Per-database registry of compound indexes
- `SortedIndex` - Single sorted compound index
- `compoundKey(values)` - Canonical JSON-encoded key

### `query-planner.js`

Turns a `.where(filter)` declaration into an execution plan that picks between a secondary-index lookup and a fallback full-collection scan. Returns a uniform `{useIndex, candidateIds, residualFilter}` shape consumed by QueryBuilder.

**Exports:**
- `QueryPlanner` class - `planWhere(collection, filter)` returns the plan

### `filter-compiler.js`

Shared filter compiler used by `.where`, `.having`, and the query planner's residual filter. Compiles object filters (with operators `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$exists`) into JS predicates. Function filters pass through unchanged. Single source of truth so all three callers agree on operator semantics.

**Exports:**
- `compileFilter(filter)` - Returns `(doc) => boolean`
- `default` - Same as compileFilter

### `graph-index.js`

Per-database adjacency index for edge collections. Maintains forward (outgoing) and inverse (incoming) adjacency maps keyed by `(collection, nodeId, predicate)`, populated by the middleware on edge writes. `outgoing` / `incoming` return edge $IDs in O(degree). Serializable POJO for snapshot persistence.

**Exports:**
- `GraphIndex` class - `declareEdge`, `insertEdge`, `removeEdge`, `outgoing`, `incoming`, `edgeSpecFor`, `serialize`, `load`
- `default` - Same as GraphIndex

### `graph-expand.js`

Multi-hop BFS expansion (UC-G6) — the implementation behind `entity.expand({...})`. Walks outward from a seed entity through an edge collection up to a hop budget, collecting reachable nodes, edges, and paths. Cycle detection via per-traversal visited-set on node $IDs; budget enforcement on results count and elapsed milliseconds (checked between hops to avoid measurement overhead on tiny graphs); honors `predicates` whitelist and `direction` ('out' | 'in' | 'both'); skips phantom adjacency entries silently per the resilience contract. Output shape: `{nodes, edges, paths, complete, incompleteReason}`.

**Exports:**
- `expand(args)` - Run BFS; returns the result object
- `default` - Same as expand

### `graph-algo.js`

Graph algorithms namespace (UC-G5) — `createAlgo({registry, getDb})` returns `{ degree, ... }`. Degree centrality iterates every node in `collection`, sums incoming + outgoing edges from `via`, optionally weighted by a named edge field; sorts by degree desc with optional top-k cap. PPR is scoped for v3 per spec §6.3.

**Exports:**
- `createAlgo({registry, getDb})` - Builds the algo namespace
- `default` - Same as createAlgo

### `chain-walk.js`

Self-ref chain walker (UC-G4) — the implementation behind `entity.chain.{field}`. `makeChainProxy` returns a Proxy whose property access validates the named field is a self-referential ref (refs to other collections throw with a diagnostic recommending `.and.{field}`) and exposes a callable+thenable walker bound to that field. `walkChain` performs the BFS-style hop sequence with cycle detection (visited-set on $ID) and `maxDepth` cap (default 10000); returns flat `Array<entity>` on clean termination at null, or `{chain, cycleDetected:true}` / `{chain, truncated:true}` on early termination.

**Exports:**
- `makeChainProxy({target, registry, wrapper, subjectCollection})` - Build the Proxy
- `walkChain({target, field, wrapper, maxDepth?})` - Run a single walk

### `predicate-inverse-related.js`

Inverse + related accessors (UC-G1 read-side) — `makeInverseProxy({target, registry, wrapper, objectCollection})` returns a Proxy whose `.{predicate}` reads incoming adjacency via graphIndex.incoming and hydrates from-side endpoints; `makeRelatedAccessor({target, registry, wrapper, subjectCollection})` flattens outgoing edges across every predicate registered for the subject collection. Both expose `.$` for the underlying edge documents. Extracted from predicate-proxy.js to keep that file under the 260-source-line gate.

**Exports:**
- `makeInverseProxy(args)` - Build the InverseProxy
- `makeRelatedAccessor(args)` - Build the RelatedAccessor

### `predicate-proxy.js`

Resolves property accesses on reactive entities to predicate-aware accessors when the schema's `$edge` block registered a matching predicate. `resolvePredicateAccess(target, name, registry, wrapper)` returns a PredicateAccessor (callable for writes, thenable for reads, `.limit(n)` for top-k, `.$` for edge documents) when the access is a registered predicate; an InverseProxy when name is `'inverse'`; a RelatedAccessor (thenable + `.$`) when name is `'related'`; or undefined otherwise so the reactive proxy falls through to field access. Writes route through `db.add.{edgeCollection}` so middleware (validation + graph-index sync) fires identically to direct user calls.

**Exports:**
- `resolvePredicateAccess(target, name, registry, wrapper)` - The resolution algorithm — also routes `expand` to graph-expand.js, `chain` to a self-ref walker (with cycle + maxDepth detection), and exposes `.history` / `.confidence(t)` / `.withProvenance` chain methods on the PredicateAccessor when the edge collection's schema declares the corresponding $supersession / $confidence / $provenance flags

### `schema-edge-declare.js`

Helpers for processing the `$edge` block at schema-declaration time. `buildEdgeSpec(collection, schemaDef)` resolves concrete from/to field names from the schema's ref-typed fields in declaration order (per spec §2.1.3), validates predicate names against the frozen `RESERVED_PROXY_NAMES` list (§0.4), and emits the enriched edge spec consumed by GraphIndex + predicate-proxy. `registerPredicateRouting` wires (subject collection, predicate) to the matching edge collection and rejects cross-schema ambiguity. `registerInversePredicateRouting` mirrors that under the to-collection so `acme.inverse.works_at` can find the matching edge collection (polymorphic `'a | b'` to-constraints split on `|`; the literal `string` pseudo-collection is skipped).

**Exports:**
- `RESERVED_PROXY_NAMES` - Frozen set of reserved proxy method names
- `buildEdgeSpec(collection, schemaDef)` - Returns `{enrichedSpec, predicates}`
- `registerPredicateRouting(map, edge, edgeCollection, predicates)` - Mutates the routing map in-place
- `registerInversePredicateRouting(map, edge, edgeCollection, predicates)` - Mirror for the object-side

### `cascade.js`

Schema-scoped cancellation cascade — the §10 NON-NEGOTIABLE. `createCascade({registry, getDb})` builds a Proxy-backed namespace where `db.cascade.{scope}(id)` enumerates registered cascadeOn entries for that scope and bulk-deletes matching docs through `db.del.{collection}` so middleware (vector + graph + secondary index sync) keeps state consistent. `byField` is the explicit-list escape hatch. `{ atomic: true }` wraps in an internal txn for all-or-nothing semantics.

**Exports:**
- `createCascade({registry, getDb})` - Returns the Proxy-backed cascade namespace
- `default` - Same as createCascade

### `errors.js`

Typed error classes for the vector + graph surface (spec §2.11). Exports `BriError` and subclasses `BriValidationError`, `BriQueryError`, `BriProxyError`, `BriSchemaError`, `BriRecoveryError`, plus frozen string constants (`VECTOR_DIMS_MISMATCH`, `CASCADE_SCOPE_UNKNOWN`, etc.) so catch sites can branch on `error.code` without regexing messages.

**Exports:**
- Error classes and `ERROR_CODES` / individual code re-exports
