## Directory Structure

```
src/storage/adapters/
├── inhouse.js
├── inhouse-crud.js
├── inhouse-txn.js
├── inhouse-vector-wal-route.js
├── inhouse-graph-wal-route.js
└── inhouse-recovery.js
```

## Files

### `inhouse.js`

Main InHouseAdapter class coordinating all storage components.

**Class: InHouseAdapter**
- `connect()` - Initialize all subsystems
- `disconnect()` - Clean shutdown with final snapshot
- `publish(channel, message)` - Pub/sub publish
- `subscribe(channel, callback)` - Pub/sub subscribe
- `unsubscribe(channel, callback)` - Pub/sub unsubscribe
- `getStats()` - Get stats from all subsystems
- `registerVectorIndex(collection, schema, index)` - Register a per-collection VectorIndex + schema for snapshot persistence and WAL-replay sync
- `getVectorEntry(collection)` - Look up persisted vector entry (loaded from snapshot)
- `vectorEntries()` - Iterate all registered vector entries (used by snapshot serialization)
- `bindSecondaryIndexManager(mgr)` - Bind the schema registry's SecondaryIndexManager so snapshots can persist its state
- `getSecondaryIndexState()` - Return pre-loaded secondary index state (from snapshot) for the registry to consume on first use
- `setPendingSecondaryState(state)` - Capture secondary index state during recovery
- `bindGraphIndex(graphIndex)` - Bind the registry's GraphIndex for snapshot persistence (UC-G7); on bind, drains pending snapshot state into the live index AND flushes any deferred WAL-replay edge ops captured during recover()
- `getPendingGraphState()` - Return pre-loaded GraphIndex state (snapshot v4 payload) for the registry
- `setPendingGraphState(state)` - Capture GraphIndex state during recovery (called by inhouse-recovery on v4 load)
- `iterateHotDocsByPrefix(prefix)` - Sync enumeration of hot-tier doc bodies by $ID prefix; consumed by the schema registry's auto-rebuild path on edge-collection declare for v3→v4 migration

### `inhouse-crud.js`

CRUD operations with transaction awareness.

**Methods:**
- `set(key, value, options)` - Store document
- `get(key, options)` - Retrieve document
- `rename(oldKey, newKey, options)` - Rename key
- `sAdd(setName, member, options)` - Add to set
- `sMembers(setName, options)` - Get set members
- `sRem(setName, member, options)` - Remove from set
- `hardDelete(key)` - Append WAL `DELETE`, remove from hot tier, drop cold ghost, prune type-catalog set membership, synchronise vector index (distinct from soft `db.del` which renames keys)

### `inhouse-vector-wal-route.js`

Shared helpers: build prefix→collection map from the vector registry and remove a `$ID` from the matching VectorIndex — used by `recover()` replay and `hardDelete()`.

### `inhouse-graph-wal-route.js`

UC-G7 / Persistent GraphIndex sibling of `inhouse-vector-wal-route.js`. Builds a prefix→{collection, edgeSpec} map from a loaded GraphIndex serialization payload (`pendingGraphState.specs`); used by `recover()` to identify edge-collection writes during WAL replay and route them into a deferred queue that `bindGraphIndex` drains. Returns an empty Map when no graph state was loaded (fresh DB / v3-and-earlier snapshot) — caller then skips the deferred-op buffering path entirely.

**Exports:**
- `buildPrefixToEdgeCollectionMap(pendingState)` - Returns `Map<prefix, {collection, edgeSpec}>`
- `default` - Same as buildPrefixToEdgeCollectionMap

### `inhouse-txn.js`

Transaction API delegation.

**Methods:**
- `rec()` - Start transaction
- `fin(txnId)` - Commit transaction
- `nop(txnId)` - Cancel transaction
- `pop(txnId)` - Undo last action
- `txnStatus(txnId)` - Get status
- `listPendingTxns()` - List pending

### `inhouse-recovery.js`

Recovery and snapshot methods.

**Methods:**
- `recover()` - Load snapshot + replay WAL; routes vector SET/DELETE via `inhouse-vector-wal-route` and edge SET/DELETE into `_deferredGraphOps` via `inhouse-graph-wal-route` (UC-G7); on WAL `DELETE`, also removes the doc id from the type catalog set (`VENK?`, etc.) and captures the pre-delete body for graph cleanup before hot-tier drops it
- `loadSnapshotV2(docs, cols)` - Load v2 format; attaches root `$ID` protos then runs `attachToString()` from `engine/helpers.js` for nested refs
- `loadVectorState(serializedIndices, schemas)` - Load v3 vector indices and schemas into the store's vector registry
- `getSnapshotState()` - Prepare snapshot data; emits v4 when GraphIndex state is present, v3 when only vector/secondary state exists, v2 otherwise (forward-compat: v3 readers ignore the unknown `graphIndices` field)
- `createSnapshot()` - Create snapshot and rotate WAL
