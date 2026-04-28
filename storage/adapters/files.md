## Directory Structure

```
adapters/
├── inhouse.js
├── inhouse-crud.js
├── inhouse-txn.js
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

### `inhouse-crud.js`

CRUD operations with transaction awareness.

**Methods:**
- `set(key, value, options)` - Store document
- `get(key, options)` - Retrieve document
- `rename(oldKey, newKey, options)` - Rename key
- `sAdd(setName, member, options)` - Add to set
- `sMembers(setName, options)` - Get set members
- `sRem(setName, member, options)` - Remove from set

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
- `recover()` - Load snapshot + replay WAL; routes vector ops in WAL records into the loaded vector indices
- `loadSnapshotV2(docs, cols)` - Load v2 format
- `loadVectorState(serializedIndices, schemas)` - Load v3 vector indices and schemas into the store's vector registry
- `getSnapshotState()` - Prepare snapshot data; emits v3 if any vector schemas are registered, v2 otherwise
- `createSnapshot()` - Create snapshot and rotate WAL
