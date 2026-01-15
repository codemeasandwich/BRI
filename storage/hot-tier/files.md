## Directory Structure

```
hot-tier/
├── cache.js
├── cache-eviction.js
└── cache-snapshot.js
```

## Files

### `cache.js`

Main HotTierCache class with document and collection storage.

**Class: HotTierCache**
- `set(key, value, dirty)` - Store document
- `get(key)` - Retrieve document (loads from cold if needed)
- `has(key)`, `isCold(key)` - Check existence
- `delete(key)`, `rename(oldKey, newKey)` - Modify keys
- `markClean(key)`, `getDirtyEntries()` - Dirty tracking
- `sAdd`, `sMembers`, `sRem`, `sExists` - Set operations
- `getStats()` - Memory and document statistics

### `cache-eviction.js`

Eviction logic methods.

**Methods:**
- `calculateScore(entry)` - Compute LRU score
- `needsEviction()` - Check memory threshold
- `evict()` - Run eviction cycle

### `cache-snapshot.js`

Snapshot and bulk loading methods.

**Methods:**
- `getAllDocuments()` - Export hot documents
- `getAllDocumentsForSnapshot(parseJSS)` - Export with resolved references
- `getAllCollections()` - Export collections
- `loadDocuments(docs)` - Bulk import documents
- `loadCollections(cols)` - Bulk import collections
