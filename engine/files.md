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
├── vector-index.js
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
- `createSchemaRegistry(store)` - Returns registry with `declare`, `get`, `vectorIndex`, `vectorFieldOf`, `validate`. The optional `store` argument enables persistence-aware declares.

### `vector-index.js`

In-process vector index for k-NN search. v1 uses a brute-force linear scan backed by `Float32Array` storage; the public interface (`add`, `remove`, `search`, `searchFiltered`, `stats`, `serialize`, `deserialize`) is pluggable so a v2 HNSW or USearch backend slots in without API changes. `serialize()` packs the index into a compact binary buffer (custom format with magic 'VIDX' + version) for snapshot embedding; `deserialize()` validates the magic/version and reconstructs the index, including slot-id pairs and the Float32Array buffer.

**Exports:**
- `VectorIndex` class - One instance per vector-bearing collection
- `default` - Same as VectorIndex

### `vector-middleware.js`

Middleware that keeps the per-collection VectorIndex in sync with add/set/del operations and enforces schemas registered through the registry. Validation runs before next() (invalid writes short-circuit before storage); index sync runs after next() (so ctx.result.$ID is populated).

**Exports:**
- `vectorIndexMiddleware(registry)` - Returns the middleware function
- `default` - Same as vectorIndexMiddleware
