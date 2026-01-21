## Directory Structure

```
server/
├── crud.js
├── handlers.js
├── utils.js
├── index.js
└── package.json
```

## Files

### `crud.js`

CRUD operation handlers for database operations.

**Exports:**
- `handleGet(db, state, collection, payload, opts)` - Query entities
- `handleAdd(db, state, collection, payload, opts)` - Create entities
- `handleSet(db, state, collection, payload, opts)` - Replace entities
- `handleDel(db, state, collection, payload, opts)` - Delete entities

### `handlers.js`

RPC request routing and non-CRUD operation handlers.

**Exports:**
- `handleRPC(db, ws, type, payload)` - Route and handle RPC requests

**Supported Operations:**
- `db/get/<collection>` - Query entities
- `db/add/<collection>` - Create entities
- `db/set/<collection>` - Replace entities
- `db/del/<collection>` - Delete entities
- `db/sub/<collection>` - Subscribe to changes
- `db/unsub/<collection>` - Unsubscribe
- `db/populate` - Populate entity references
- `db/save` - Save entity changes
- `db/txn/<op>` - Transaction operations (rec/fin/nop/pop/status)

### `utils.js`

Connection state management and serialization utilities.

**Exports:**
- `getState(socket)` - Get or create connection state for a WebSocket
- `deleteState(socket)` - Remove connection state on disconnect
- `toPlainObject(entity)` - Convert reactive entity to plain object for transmission

### `index.js`

Main server entry point with WebSocket setup.

**Exports:**
- `db` - Database instance
- `getState` - Re-exported from utils

**Environment Variables:**
- `PORT` - Server port (default: 3000)
- `DATA_DIR` - BRI data directory (default: /data)
- `MAX_MEMORY_MB` - Memory limit (default: 256)
- `ENCRYPTION_KEY` - Optional encryption key
- `AUTH_REQUIRED` - Enable authentication (default: false)

### `package.json`

Server dependencies (bri).
