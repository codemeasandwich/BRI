## Directory Structure

```
client/
├── index.js
└── proxy.js
```

## Files

### `index.js`

Database factory and singleton management.

**Exports:**
- `createDB(options)` - Create new database instance
- `getDB(options)` - Get or create singleton instance
- `default` - Alias for createDB

**Options:**
- `storeType` - Storage backend ('inhouse')
- `storeConfig` - Storage configuration object

### `proxy.js`

Proxy-based API handlers with middleware integration.

**Exports:**
- `createDBInterface(wrapper, store)` - Create public DB interface

**Interface Methods:**
- `db.sub.<type>(callback)` - Subscribe to changes
- `db.get.<type>(where?, opts?)` - Get documents
- `db.add.<type>(data, opts?)` - Create document
- `db.set.<type>(data, opts?)` - Replace document
- `db.del.<type>($ID, deletedBy?)` - Delete document
- `db.pin.<type>(key, val, expire)` - Cache value

**Transaction Methods:**
- `db.rec()` - Start transaction, returns txnId
- `db.fin(txnId?)` - Commit transaction
- `db.nop(txnId?)` - Cancel transaction
- `db.pop(txnId?)` - Undo last action
- `db.txnStatus(txnId?)` - Get status

**Middleware Methods:**
- `db.use(fn)` - Register middleware
- `db.middleware` - Access middleware runner

**Internal:**
- `db._activeTxnId` - Current transaction ID
- `db._store` - Storage adapter reference
- `db.disconnect()` - Graceful shutdown
