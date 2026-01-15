## Directory Structure

```
storage/
├── index.js
├── interface.js
├── adapters/
│   ├── inhouse.js
│   ├── inhouse-crud.js
│   ├── inhouse-txn.js
│   └── inhouse-recovery.js
├── hot-tier/
│   ├── cache.js
│   ├── cache-eviction.js
│   └── cache-snapshot.js
├── cold-tier/
│   └── files.js
├── wal/
│   ├── entry.js
│   ├── writer.js
│   └── reader.js
├── snapshot/
│   └── manager.js
├── pubsub/
│   └── local.js
└── transaction/
    ├── manager.js
    ├── txn-operations.js
    ├── txn-undo.js
    └── txn-recovery.js
```

## Files

### `index.js`

Storage factory creating adapter instances based on configuration.

### `interface.js`

Configuration defaults and validation for storage backends.
