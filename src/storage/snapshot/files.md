## Directory Structure

```
src/storage/snapshot/
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
- `version` - Schema version (v1, v2 — no vectors; v3 — vectors + secondary indexes; v4 — adds persistent GraphIndex per UC-G7)
- `walLine` - WAL line number at snapshot time
- `timestamp` - Creation timestamp
- `documents` - All hot documents
- `collections` - All collections
- `vectorIndices` - (v3+) base64-packed VectorIndex buffers, keyed by collection
- `vectorSchemas` - (v3+) `{collection: {field, dims, metric}}` for drift detection on reboot
- `secondaryIndexes` - (v3+) POJO from `SecondaryIndexManager.serialize()` carrying declared compound indexes
- `graphIndices` - (v4) POJO from `GraphIndex.serialize()` carrying edge specs and outgoing/incoming adjacency for every registered edge collection. Forward-compat: v3 readers ignore the unknown field; the rest of the v3 payload is unchanged.

The manager itself is format-agnostic: state fields are passed through verbatim alongside `version` and `timestamp`. Each writer (storage adapter) decides which keys make sense at which version.
