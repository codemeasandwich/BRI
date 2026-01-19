## Directory Structure

```
remote/
├── index.js
├── connection.js
├── proxy.js
├── entity.js
└── readMe.md
```

## Files

### `index.js`

Remote database client entry point. Provides BRI API over WebSocket via api-ape.

**Exports:**
- `createRemoteDB(url, options)` - Create remote database connection
- `apiDB(url?)` - Alias with default URL (ws://localhost:3000)
- `default` - Alias for createRemoteDB

**Options:**
- `timeout` - RPC timeout in milliseconds (default: 30000)

### `connection.js`

WebSocket connection wrapper with promise-based RPC.

**Exports:**
- `createConnection(url)` - Establish WebSocket connection

**Returns Interface:**
- `send(type, payload)` - Send RPC request, returns promise
- `on(type, callback)` - Subscribe to broadcast events
- `close()` - Close connection
- `isConnected()` - Check connection status

### `proxy.js`

CRUD operation proxy factory. Creates Proxy objects that intercept property access to build RPC paths matching BRI's API.

**Exports:**
- `createOperationProxy(operation, rpc, wrapEntity)` - Create CRUD proxy

**Handles:**
- `db.get.user(id)` - Get single by ID
- `db.get.userS()` - Get all
- `db.get.userS({ field: value })` - Get all matching query
- `db.get.userS(fn)` - Client-side filter (fetches all, filters locally)
- `db.add.user(data, opts?)` - Create entity
- `db.set.user(data, opts?)` - Replace entity
- `db.del.user(id, deletedBy?)` - Delete entity
- `.populate('field')` - Chainable population

### `entity.js`

Remote entity wrapper. Wraps plain objects from server to provide BRI-like behavior.

**Exports:**
- `wrapEntity(data, rpc)` - Wrap plain object as entity

**Entity Methods:**
- `.and.fieldName` - Population chaining (makes RPC calls)
- `.save(opts?)` - Send changes to server
- `.populate(fields)` - Chainable population
- `.toObject()` - Plain JS object copy
- `.toJSON()` - JSON-serializable data
- `.toJSS()` - Extended serialization
- `.toString()` - Returns $ID
- `.$ID` - Entity identifier

**Features:**
- Nested change tracking
- Array mutation tracking (push, splice, pop, shift, unshift)

### `readMe.md`

Usage documentation and API reference.
