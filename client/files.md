## Directory Structure

```
client/
├── index.js
├── proxy.js
└── query-builder.js
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
- `db.get.<type>(where?, opts?)` - Get documents (legacy callable form)
- `db.get.<type>S.where(...).near(...)` - Chainable query builder (group form only)
- `db.add.<type>(data, opts?)` - Create document
- `db.set.<type>(data, opts?)` - Replace document
- `db.del.<type>($ID, deletedBy?)` - Delete document
- `db.pin.<type>(key, val, expire)` - Cache value
- `db.schema(collection, schemaDef)` - Register a schema; auto-instantiates vector index if schema declares a vector field

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
- `db._registry` - Schema registry instance (for advanced introspection)
- `db.disconnect()` - Graceful shutdown

### `query-builder.js`

Chainable query builder used by the new `db.get.{collection}S.where(...).near(...)` surface. Immutable per-link chain (each chain method returns a new builder). Composes attribute filters with vector search by feeding `.where` predicates into the `VectorIndex.searchFiltered` traversal so filtering happens before k-truncation.

**Exports:**
- `QueryBuilder` class - chain methods: `where`, `near`, `limit`, `toArray`, `first`; thenable so `await builder` works.
- `default` - Same as QueryBuilder
