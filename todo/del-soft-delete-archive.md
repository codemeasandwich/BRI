# DEL: Robust Soft-Delete with Archive and Restore

## Overview

A comprehensive deletion mechanism that preserves data integrity, enables audit trails, and supports recovery workflows. Deleted items are archived rather than permanently erased, allowing administrators to view deletion history and restore accidentally deleted data.

## Current State

BRI already implements a basic soft-delete pattern:
- Documents are renamed from `KEY` to `X:KEY:X`
- `deletedAt` and `deletedBy` metadata are added
- Items are removed from collection indexes (`sRem`)
- Data remains in storage but is excluded from queries

### Limitations of Current Approach
1. No dedicated archive storage - deleted items clutter active storage
2. No deletion audit log - only per-document metadata
3. No bulk restore capability
4. No admin visibility into deleted items
5. No automatic cleanup/purge of old deletions
6. Deleted items still consume hot/cold tier memory

## Proposed Architecture

### 1. Archive Storage Layer

```
data/
├── archive/
│   ├── index.jss              # Deletion index with metadata
│   ├── USER/
│   │   └── {id}.jss           # Archived user documents
│   └── POST/
│       └── {id}.jss           # Archived post documents
```

**Archive Index Structure** (`archive/index.jss`):
```javascript
{
  version: 1,
  entries: {
    "USER_abc1234": {
      originalKey: "USER_abc1234",
      type: "USER",
      deletedAt: Date,
      deletedBy: "USER_xyz789",    // ID of user who deleted
      deletedByName: "John Admin", // Cached name for audit display
      reason: "User requested account deletion",
      restorable: true,
      archivePath: "USER/abc1234.jss",
      originalData: { /* snapshot of document at deletion time */ },
      relatedDeletions: ["POST_def456", "POST_ghi789"] // Cascade tracking
    }
  },
  stats: {
    totalArchived: 42,
    byType: { USER: 5, POST: 37 },
    oldestEntry: Date,
    newestEntry: Date
  }
}
```

### 2. Enhanced Delete API

```javascript
// Basic delete (current behavior, enhanced)
await db.del.user(userId, deletedBy);

// Delete with options
await db.del.user(userId, {
  deletedBy: "USER_admin123",
  reason: "Spam account",
  cascade: true,              // Delete related entities
  immediate: false,           // true = bypass archive, permanent delete
  notify: true                // Emit deletion event
});

// Bulk delete
await db.del.userS(
  user => user.status === 'inactive',
  { deletedBy: "SYSTEM", reason: "Inactive cleanup" }
);
```

### 3. Archive Manager Component

**File**: `storage/archive/manager.js`

```javascript
export class ArchiveManager {
  constructor(dataDir, options = {}) {
    this.archiveDir = path.join(dataDir, 'archive');
    this.indexPath = path.join(this.archiveDir, 'index.jss');
    this.retentionDays = options.retentionDays || 90;
    this.maxArchiveSizeMB = options.maxArchiveSizeMB || 1024;
  }

  // Core operations
  async archive(key, document, metadata) { }
  async restore(key, restoredBy) { }
  async permanentDelete(key) { }
  async getArchived(key) { }

  // Query operations
  async listArchived(options) { }  // Filter by type, date range, deletedBy
  async searchArchived(query) { }

  // Maintenance
  async purgeExpired() { }         // Remove entries older than retention
  async getStats() { }
  async compact() { }              // Rebuild index, remove orphans
}
```

### 4. Delete Operation Flow

```
User calls db.del.user(id, opts)
           │
           ▼
┌──────────────────────────┐
│ 1. Fetch current document│
│    from hot/cold tier    │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 2. Create archive entry  │
│    with full document    │
│    and metadata          │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 3. Write to archive      │
│    - Save document file  │
│    - Update index        │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 4. Write WAL entry       │
│    action: 'ARCHIVE'     │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 5. Remove from active    │
│    - Delete from hot tier│
│    - Remove from index   │
└───────────┬──────────────┘
            │
            ▼
┌──────────────────────────┐
│ 6. Publish DELETE event  │
│    with archive reference│
└──────────────────────────┘
```

### 5. Restore Operation

```javascript
// Admin restore API
await db.restore.user(archivedId, {
  restoredBy: "USER_admin123",
  reason: "Accidental deletion",
  preserveTimestamps: false    // true = keep original createdAt/updatedAt
});

// Restore with conflict handling
await db.restore.user(archivedId, {
  restoredBy: "USER_admin123",
  onConflict: 'rename'         // 'rename' | 'overwrite' | 'fail'
});
```

**Restore Flow**:
```
1. Read archived document from archive storage
2. Validate document can be restored (no ID conflicts)
3. Add restoredAt, restoredBy, restoredFrom metadata
4. Write to active storage (hot tier + WAL)
5. Add to collection index
6. Remove from archive (or mark as restored)
7. Publish RESTORE event
```

### 6. Admin Interface

```javascript
// List all deleted items
const archived = await db.archive.list({
  type: 'USER',                    // Filter by type
  deletedBy: 'USER_admin123',      // Filter by who deleted
  deletedAfter: new Date('2024-01-01'),
  deletedBefore: new Date('2024-06-01'),
  limit: 50,
  offset: 0,
  sortBy: 'deletedAt',
  sortOrder: 'desc'
});

// Returns:
{
  items: [
    {
      $ID: "USER_abc1234",
      type: "USER",
      deletedAt: Date,
      deletedBy: "USER_xyz789",
      deletedByName: "John Admin",
      reason: "Spam account",
      preview: { name: "Spammer", email: "spam@..." }, // Partial data
      restorable: true,
      relatedCount: 3  // Number of cascade-deleted items
    }
  ],
  total: 142,
  hasMore: true
}

// Get full archived document
const fullDoc = await db.archive.get("USER_abc1234");

// Get deletion audit trail
const auditLog = await db.archive.audit({
  entityId: "USER_abc1234",      // Specific entity
  // OR
  actorId: "USER_admin123",      // All actions by this user
  // OR
  type: "USER",                  // All USER deletions
  includeRestores: true
});
```

### 7. Cascade Deletion Tracking

When deleting entities with relationships:

```javascript
await db.del.user(userId, {
  deletedBy: adminId,
  cascade: true,
  cascadeTypes: ['POST', 'COMMENT']  // Only cascade these types
});
```

**Cascade Archive Entry**:
```javascript
{
  "USER_abc1234": {
    // ... deletion metadata
    cascadeRoot: true,
    cascadeChildren: ["POST_def456", "COMMENT_ghi789"]
  },
  "POST_def456": {
    // ... deletion metadata
    cascadeParent: "USER_abc1234",
    cascadeRoot: false
  }
}
```

**Cascade Restore**: Optionally restore all related deletions:
```javascript
await db.restore.user(userId, {
  restoredBy: adminId,
  includeCascade: true  // Restore all cascade-deleted items
});
```

### 8. WAL Integration

New WAL operation types:

```javascript
WALOp = {
  // Existing
  SET: 'SET',
  DELETE: 'DELETE',
  RENAME: 'RENAME',
  SADD: 'SADD',
  SREM: 'SREM',

  // New for archive
  ARCHIVE: 'ARCHIVE',     // Move to archive
  RESTORE: 'RESTORE',     // Restore from archive
  PURGE: 'PURGE'          // Permanent deletion from archive
}
```

**ARCHIVE WAL Entry**:
```javascript
{
  action: 'ARCHIVE',
  target: 'USER_abc1234',
  archivePath: 'USER/abc1234.jss',
  deletedBy: 'USER_admin123',
  reason: 'Spam account',
  cascadeParent: null,
  timestamp: Date
}
```

### 9. Configuration

```javascript
const db = await createDB({
  storeConfig: {
    dataDir: './data',
    maxMemoryMB: 256,

    // Archive configuration
    archive: {
      enabled: true,
      retentionDays: 90,           // Auto-purge after 90 days
      maxSizeMB: 1024,             // Max archive storage
      compactIntervalMs: 86400000, // Daily compaction
      indexInMemory: true,         // Keep index in memory for fast queries

      // Purge settings
      purgeSchedule: '0 3 * * *',  // Cron: 3 AM daily
      purgeOnStartup: false,

      // What to archive
      archiveOnDelete: true,       // Archive all deletes by default
      excludeTypes: ['SESSION', 'TOKEN'],  // Never archive these types

      // Cascade defaults
      defaultCascade: false,
      cascadeRelations: {
        USER: ['POST', 'COMMENT'],
        POST: ['COMMENT']
      }
    }
  }
});
```

### 10. Recovery Considerations

**Snapshot Integration**:
- Archive index included in snapshots for fast recovery
- Archive files are NOT included in snapshots (separate backup)
- WAL replay reconstructs archive state

**Startup Recovery**:
```javascript
async recover() {
  // 1. Load main snapshot
  // 2. Load archive index
  // 3. Replay WAL (including ARCHIVE/RESTORE/PURGE ops)
  // 4. Verify archive integrity
  // 5. Run purge if configured
}
```

### 11. Migration from Current System

For existing databases with `X:KEY:X` soft-deleted items:

```javascript
// One-time migration script
await db.archive.migrate({
  dryRun: false,
  defaultDeletedBy: 'SYSTEM',
  defaultReason: 'Migrated from legacy soft-delete'
});
```

This scans for `X:*:X` keys and moves them to proper archive storage.

## API Summary

| Operation | Method | Description |
|-----------|--------|-------------|
| Delete | `db.del.type(id, opts)` | Archive and remove from active |
| Bulk Delete | `db.del.typeS(filter, opts)` | Archive multiple items |
| Restore | `db.restore.type(id, opts)` | Restore from archive |
| List Archived | `db.archive.list(opts)` | Query archived items |
| Get Archived | `db.archive.get(id)` | Get full archived document |
| Purge | `db.archive.purge(id)` | Permanently delete |
| Audit | `db.archive.audit(opts)` | Get deletion history |
| Stats | `db.archive.stats()` | Archive statistics |
| Migrate | `db.archive.migrate(opts)` | Migrate legacy deletions |

## Security Considerations

1. **Permission Model**: Restore/purge operations should require elevated permissions
2. **Audit Immutability**: Archive index entries should be append-only
3. **Data Sensitivity**: Consider encryption for archived data containing PII
4. **Retention Compliance**: Configurable retention for GDPR/legal requirements

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `storage/archive/manager.js` | Create | Archive manager class |
| `storage/archive/index.js` | Create | Archive index operations |
| `storage/wal/entry.js` | Modify | Add ARCHIVE/RESTORE/PURGE ops |
| `engine/operations-remove.js` | Modify | Integrate archive on delete |
| `engine/operations-restore.js` | Create | Restore operations |
| `client/proxy.js` | Modify | Add db.restore and db.archive |
| `storage/adapters/inhouse.js` | Modify | Initialize archive manager |
| `storage/adapters/inhouse-recovery.js` | Modify | Recovery with archive |
