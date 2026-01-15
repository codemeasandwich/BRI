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
- `version` - Schema version
- `walLine` - WAL line number at snapshot time
- `timestamp` - Creation timestamp
- `documents` - All hot documents
- `collections` - All collections
