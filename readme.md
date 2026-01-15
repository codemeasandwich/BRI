# Bri: Bigdata Repository of Intelligence

This Bri database provides an easy-to-use interface for performing CRUD (Create, Read, Update, Delete) operations on documents. It also includes additional features such as subscribing to document changes and populating attributes with IDs.

**Note**: All documents, when created, are assigned a unique `$ID` in the form of four capitalized letters, representing the first two and last two characters of the document type name, followed by an underscore and then 7 base 32 characters (in Crockford encoding format). There is also a `createdAt` and `updatedAt` timestamp managed by the database that cannot be modified by the client.

## Table of Contents

- [Installation](#installation)
- [Storage Backends](#storage-backends)
  - [In-House Store](#in-house-store)
- [Usage](#usage)
  - [Action Functions](#action-functions)
  - [Document Retrieval Behavior](#document-retrieval-behavior)
  - [Additional Properties for Retrieved Records](#additional-properties-for-retrieved-records)
- [Examples](#examples)
  - [Adding a Document](#adding-a-document)
  - [Retrieving a Document](#retrieving-a-document)
  - [Updating a Document](#updating-a-document)
  - [Deleting a Document](#deleting-a-document)
  - [Subscribing to Changes](#subscribing-to-changes)
  - [Populating Attributes](#populating-attributes)
  - [Transactions](#transactions)
  - [Middleware (Plugins)](#middleware-plugins)

## Installation

```bash
npm install bri
```

## Storage Backends

### In-House Store

A self-contained persistent store with no external dependencies. Features:

- **Hot Tier**: In-memory LRU cache with frequency-weighted eviction
- **Write-Ahead Log (WAL)**: Durability and crash recovery
- **Snapshots**: Periodic full-state dumps (default: every 30 minutes)
- **Cold Tier**: JSON file storage for data that doesn't fit in memory

#### Configuration

```javascript
const { createStore } = require('./store');

const store = await createStore({
  type: 'inhouse',
  config: {
    dataDir: './data',           // Where to store data files
    maxMemoryMB: 256,            // Required: memory limit for hot tier
    evictionThreshold: 0.9,      // Trigger eviction at 90% memory usage
    snapshotIntervalMs: 1800000, // Snapshot every 30 minutes
    keepSnapshots: 3,            // Keep last 3 snapshots
    fsyncMode: 'batched',        // WAL sync mode: 'always', 'batched', 'os'
    fsyncIntervalMs: 100         // Batch sync interval
  }
});
```

#### Data Directory Structure

```
data/
├── docs/           # Document JSON files
│   └── US_abc1234.json
├── sets/           # Collection index files
│   └── US.json
├── wal/            # Write-ahead log segments
│   └── 000001.wal
├── txn/            # Transaction WAL files (one per active transaction)
│   └── txn_abc1234.wal
└── snapshots/      # Periodic state snapshots
    └── snap_1704067200.json
```

#### Store API

The in-house store provides the following interface:

```javascript
// Key-Value Operations
await store.set(key, value);
const value = await store.get(key);
await store.rename(oldKey, newKey);

// Set Operations
await store.sAdd(setName, member);
const members = await store.sMembers(setName);
await store.sRem(setName, member);

// Pub/Sub
await store.publish(channel, message);
await store.subscribe(channel, callback);
await store.unsubscribe(channel, callback);

// Maintenance
await store.createSnapshot();
const stats = await store.getStats();
await store.disconnect();

// Transactions
const txnId = store.rec();           // Start transaction
await store.fin(txnId);              // Commit transaction
await store.nop(txnId);              // Cancel transaction
await store.pop(txnId);              // Undo last action
const status = store.txnStatus(txnId); // Get transaction status
```

## Usage

First, you need to import the library in your JavaScript or TypeScript project:

```javascript
const db = require('bri');
```

For TypeScript or ECMAScript modules, use:

```javascript
import * as db from 'bri';
```

After importing the library, you can use the provided action functions to interact with the database.

### Action Functions

There are nine action functions for interacting with the database:

- `sub`: Subscribe to changes in documents.
- `get`: Retrieve a document.
- `add`: Insert a new document.
- `set`: Replace an existing document.
- `del`: Delete a document.
- `rec`: Start recording a transaction.
- `fin`: Commit (finish) a transaction.
- `nop`: Cancel a transaction.
- `pop`: Undo the last action in a transaction.

### Document Retrieval Behavior

- If a capital "S" is appended to the action function (e.g., `db.get.fooS()`), all matching documents are returned.
- Otherwise, only the first matching document is returned.

### Additional Properties for Retrieved Records

Retrieved records have two additional properties:

- `save()`: Persist any changes made to the current document.
- `.and.`: Populate an attribute with IDs, e.g., `const userWithPopulatedFriendsList = await user.and.friends()`.

## Examples

### Adding a Document

```javascript
db.add.foo({ a: { b: [1, 2] } }).then((foo) => {
  console.log("foo", foo);
});
```

### Retrieving a Document

```javascript
db.get.foo("<document-id>").then((foo) => {
  console.log("foo", foo);
});
```

### Updating a Document

```javascript
db.get.foo("<document-id>")
  .then((foo) => {
    foo.a.b.push(3);
    return foo.save();
  })
  .then((updatedFoo) => {
    console.log("updatedFoo", updatedFoo);
  });
```

### Deleting a Document

```javascript
db.del.foo("<document-id>").then(() => {
  console.log("Document deleted");
});
```

### Subscribing to Changes

```javascript
db.sub
  .user((x) => console.log("->", x))
  .then((unsub) => {
    // Perform operations here and then unsubscribe
    unsub();
  });
```

### Populating Attributes

```javascript
const userWithPopulatedFriendsList = await user.and.friends();
console.log(userWithPopulatedFriendsList);
```

### Transactions

BRI supports long-lived transactions that can span multiple operations and remain hidden from other clients until committed. This is useful for multi-step workflows like wizards or draft systems.

#### Basic Transaction Flow

```javascript
// Start recording a transaction
const txnId = db.rec();

// All operations with txnId are recorded but hidden from others
const user = await db.add.user({ name: 'Alice' }, { txnId });
const profile = await db.add.profile({ bio: 'Hello!' }, { txnId });

// Commit - changes become visible to all
await db.fin(txnId);
```

#### Automatic Transaction Binding

When you call `db.rec()`, the transaction is automatically bound to the db instance. Subsequent operations will use it without needing to pass `{ txnId }` explicitly:

```javascript
db.rec();  // Sets db._activeTxnId

// These automatically use the active transaction
const user = await db.add.user({ name: 'Bob' });
const users = await db.get.userS();  // Sees uncommitted changes

await db.fin();  // Commits and clears _activeTxnId
```

To explicitly bypass the active transaction and see what others see:

```javascript
db.rec();
await db.add.user({ name: 'Charlie' });

// Check what's visible to other clients (bypass transaction)
const visible = await db.get.userS({ txnId: null });
console.log(visible.length);  // 0 - not committed yet

await db.fin();
```

#### Transaction Operations

```javascript
// Cancel transaction - discard all changes
db.rec();
await db.add.user({ name: 'Temp' });
await db.nop();  // Discards everything, nothing saved

// Undo last action
db.rec();
await db.add.user({ name: 'First' });
await db.add.user({ name: 'Second' });
await db.pop();  // Removes 'Second', keeps 'First'
await db.fin();  // Only 'First' is committed

// Check transaction status
db.rec();
const status = db.txnStatus();
// When transaction exists:
// {
//   exists: true,
//   txnId: 'txn_abc1234',
//   actionCount: 0,      // Number of recorded actions
//   documentCount: 0,    // Documents in shadow state
//   collectionCount: 0,  // Collection sets modified
//   createdAt: Date|null // Derived from first action's timestamp (null if no actions yet)
// }
//
// When transaction does NOT exist:
// { exists: false }
```

### Middleware (Plugins)

BRI supports a middleware system for intercepting and extending CRUD operations:

```javascript
// Add custom middleware
db.use(async (ctx, next) => {
  console.log(`${ctx.operation}.${ctx.type}`, ctx.args);
  await next();
  console.log('Result:', ctx.result);
});

// Middleware context includes:
// - ctx.operation: 'get', 'add', 'set', 'del'
// - ctx.type: collection name (e.g., 'user', 'userS')
// - ctx.args: operation arguments
// - ctx.opts: options object (mutable)
// - ctx.db: database reference
// - ctx.result: operation result (after next())
```

Built-in middleware:
- **transactionMiddleware**: Auto-injects `txnId` from `db._activeTxnId`

Example plugins available in `engine/middleware.js`:
- `loggingMiddleware()`: Log all operations
- `validationMiddleware(validators)`: Validate data before writes
- `hooksMiddleware()`: Before/after hooks per operation type

## Architecture

BRI is organized into four main modules:

```
┌─────────────────────────────────────────────────────────────────┐
│                         /client                                  │
│         Public interface: .get.userS, user.and.friends          │
│              Query syntax, proxy handlers, createDB              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         /engine                                  │
│            In-memory data handling & query fulfillment           │
│     ID generation, CRUD operations, reactive change tracking     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        /storage                                  │
│              File persistence & storage adapters                 │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ Hot Tier (LRU)  │  │ WAL + Snapshots │  │ Cold Tier (JSON)│  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │ Local Pub/Sub   │                                            │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         /utils                                   │
│              diff (change tracking) & jss (serialization)        │
└─────────────────────────────────────────────────────────────────┘
```

### Module Descriptions

- **client/** - Public interface including the `.get.userS`, `user.and.friends` query syntax, proxy handlers for collection access, and the `createDB` factory function.

- **engine/** - Core database engine handling in-memory data operations, query fulfillment, ID generation, CRUD operations, and reactive change tracking via proxies.

- **storage/** - File persistence layer with the InHouse storage adapter featuring hot tier (LRU cache), cold tier (JSON files), write-ahead log (WAL), periodic snapshots, and pub/sub for change notifications.

- **utils/** - Shared utilities including `diff` for change tracking and path operations, and `jss` (JsonSuperSet) for extended JSON serialization supporting Date, Error, RegExp, Map, Set, and circular references.

## Running Tests

```bash
# Test the storage layer
node storage/test.js

# Test transactions
node storage/transaction/test.js
```
