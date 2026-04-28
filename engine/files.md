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
├── predicate-proxy.js
├── schema-edge-declare.js
├── cascade.js
├── vector-index.js
├── vector-index-codec.js
└── vector-middleware.js
```

## Files

### `index.js`

Engine factory creating operation wrappers.

**Exports:**
- `createEngine(store)` - Create engine instance
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
- `createSchemaRegistry(store)` - Returns registry with `declare`, `get`, `vectorIndex`, `vectorFieldOf`, `validate`, `secondaryIndexManager`, `vectorIndices`, `graphIndex`, `edgeSpec`, `collectionForPrefix`, `predicateEdge`, `inversePredicateEdge`, `predicatesForSubject`, `cascadeEntriesFor`. Reserved-name collision check fires at `declare` time when a `$edge.predicates` entry collides with the frozen proxy-method list. `cascadeOn`-flagged fields are registered into the per-scope lookup consumed by `db.cascade`. The optional `store` argument enables persistence-aware declares.

### `vector-index.js`

In-process vector index for k-NN search. v1 uses a brute-force linear scan backed by `Float32Array` storage; the public interface (`add`, `remove`, `search`, `searchFiltered`, `stats`, `serialize`, `deserialize`) is pluggable so a v2 HNSW or USearch backend slots in without API changes. `serialize()` packs the index into a compact binary buffer (custom format with magic 'VIDX' + version) for snapshot embedding; `deserialize()` validates the magic/version and reconstructs the index, including slot-id pairs and the Float32Array buffer. Transaction support (UC-V4) adds `addStaged` / `removeStaged` / `commit` / `rollback` / `popStaged` and `searchInTxn` for deferred-linking semantics — pending ops are buffered per-txn and flushed only on commit, so the committed buffer is never partially modified.

**Exports:**
- `VectorIndex` class - One instance per vector-bearing collection
- `default` - Same as VectorIndex

### `vector-index-codec.js`

Binary codec for VectorIndex — magic + version constants, the cosine helper, and `packIndex` / `unpackIndex` free functions that materialize the wire format. Lives next to vector-index.js so persistence can evolve independently of the index's runtime behavior.

**Exports:**
- `cosine(a, b)` - similarity helper
- `packIndex(index)` - serialize a VectorIndex to a Buffer
- `unpackIndex(buf)` - decode a Buffer into VectorIndex internal state
- `SERIALIZATION_MAGIC`, `SERIALIZATION_FORMAT_VERSION`

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

### `predicate-proxy.js`

Resolves property accesses on reactive entities to predicate-aware accessors when the schema's `$edge` block registered a matching predicate. `resolvePredicateAccess(target, name, registry, wrapper)` returns a PredicateAccessor (callable for writes, thenable for reads, `.limit(n)` for top-k, `.$` for edge documents) when the access is a registered predicate; an InverseProxy when name is `'inverse'`; a RelatedAccessor (thenable + `.$`) when name is `'related'`; or undefined otherwise so the reactive proxy falls through to field access. Writes route through `db.add.{edgeCollection}` so middleware (validation + graph-index sync) fires identically to direct user calls.

**Exports:**
- `resolvePredicateAccess(target, name, registry, wrapper)` - The resolution algorithm — also routes `expand` to graph-expand.js for parameterized BFS from the entity

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
