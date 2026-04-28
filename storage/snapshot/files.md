## Directory Structure

```
snapshot/
└── manager.js
```

## Files

### `manager.js`

Snapshot manager for periodic state dumps.

**Class: SnapshotManager**
- `create(state)` - Create snapshot from current state
- `loadLatest()` - Load most recent snapshot
- `startScheduler(createSnapshot)` - Start periodic snapshots
- `stopScheduler()` - Stop scheduler
- `getStats()` - Get snapshot file info

**Snapshot State:**
- `version` - Schema version (v1, v2 — no vectors; v3 — with vectors)
- `walLine` - WAL line number at snapshot time
- `timestamp` - Creation timestamp
- `documents` - All hot documents
- `collections` - All collections
- `vectorIndices` - (v3) base64-packed VectorIndex buffers, keyed by collection
- `vectorSchemas` - (v3) `{collection: {field, dims, metric}}` for drift detection on reboot
- `secondaryIndexes` - (v3) POJO from `SecondaryIndexManager.serialize()` carrying declared compound indexes

The manager itself is format-agnostic: state fields are passed through verbatim alongside `version` and `timestamp`. Each writer (storage adapter) decides which keys make sense at which version.
