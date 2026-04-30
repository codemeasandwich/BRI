## Directory Structure

```
src/storage/wal/
├── entry.js
├── writer.js
├── reader.js
└── record-types.js
```

## Files

### `entry.js`

WAL entry types and serialization.

**Exports:**
- `WALOp` - Operation types (SET, DELETE, RENAME, SADD, SREM)
- `hashPointer(prevPointer, entryJson)` - Create chain hash
- `createSetEntry`, `createDeleteEntry`, `createRenameEntry`, `createSAddEntry`, `createSRemEntry` - Entry constructors
- `serializeEntry(entry, prevPointer)` - Serialize to line format
- `deserializeEntry(line)` - Parse line to entry object

### `writer.js`

Append-only WAL writer with segment rotation.

**Class: WALWriter**
- `init()` - Initialize writer, find last pointer
- `append(entry)` - Queue entry for writing
- `rotate()` - Rotate to new segment
- `sync()` - Force fsync
- `archive()` - Archive current segment
- `close()` - Clean shutdown

### `reader.js`

WAL reader for recovery and integrity verification.

**Class: WALReader**
- `readEntries(afterLine)` - Async generator of entries
- `replay(afterLine, handlers)` - Replay with callbacks
- `verifyIntegrity()` - Check pointer chain
- `getLineCount()` - Total entry count

### `record-types.js`

Canonical WAL `action` name strings — document ops (SET, DELETE, …) plus index-level names (VECTOR_ADD, INDEX_INSERT, …) for observability and recovery routing per spec §3.3. Exports `WAL_RECORD_TYPES` and named re-exports for each literal.
