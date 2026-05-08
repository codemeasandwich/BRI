# Bri: Bigdata Repository of Intelligence

![Bri Cover](assets/cover.jpg)

This Bri database provides an easy-to-use interface for performing CRUD (Create, Read, Update, Delete) operations on documents. It also includes additional features such as subscribing to document changes and populating attributes with IDs.

**Note**: All documents, when created, are assigned a unique `$ID` in the form of four capitalized letters, representing the first two and last two characters of the document type name, followed by an underscore and then 7 base 32 characters (in Crockford encoding format). There is also a `createdAt` and `updatedAt` timestamp managed by the database that cannot be modified by the client.

## Table of Contents

- [Installation](#installation)
- [Storage Backends](#storage-backends)
  - [In-House Store](#in-house-store)
- [Usage](#usage)
  - [Action Functions](#action-functions)
  - [Document Retrieval Behavior](#document-retrieval-behavior)
  - [Query Filtering](#query-filtering)
  - [Reactive Entity Methods](#reactive-entity-methods)
- [Examples](#examples)
  - [Adding a Document](#adding-a-document)
  - [Retrieving a Document](#retrieving-a-document)
  - [Updating a Document](#updating-a-document)
  - [Deleting a Document](#deleting-a-document)
  - [Subscribing to Changes](#subscribing-to-changes)
  - [Populating Attributes](#populating-attributes)
  - [Transactions](#transactions)
  - [Middleware (Plugins)](#middleware-plugins)
  - [Schema Validation](#schema-validation)
  - [Vector + Graph v1](#vector--graph-v1)
  - [JSS (JsonSuperSet) Serialization](#jss-jsonsuperset-serialization)
- [TypeScript Support](#typescript-support)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Running Tests](#running-tests)
- [Quickstart (Bun)](#quickstart-bun)

## Installation

```bash
npm install bri-db
```

## Storage Backends

### In-House Store

A self-contained persistent store with no external dependencies. Features:

- **Hot Tier**: In-memory LRU cache with frequency-weighted eviction
- **Write-Ahead Log (WAL)**: Durability and crash recovery
- **Snapshots**: Periodic full-state dumps (default: every 30 minutes)
- **Cold Tier**: JSON file storage for data that doesn't fit in memory
- **Encryption at Rest**: Optional AES-256-GCM encryption for all stored data

#### Configuration

```javascript
import { createStore } from 'bri-db/storage';

const store = await createStore({
  type: 'inhouse',
  config: {
    dataDir: './data',           // Base directory for WAL, snapshots, txn, cold tier, etc.
    maxMemoryMB: 256,            // Required: memory limit for hot tier
    evictionThreshold: 0.9,      // Trigger eviction at 90% memory usage
    snapshotIntervalMs: 1800000, // Snapshot every 30 minutes
    keepSnapshots: 3,            // Keep last 3 snapshots
    fsyncMode: 'batched',        // WAL sync mode: 'always' | 'batched'
    fsyncIntervalMs: 100,        // Batch sync interval when fsyncMode is 'batched'
    logger: false,               // Optional: false silences Bri runtime logs
    encryption: {                // Optional encryption at rest
      enabled: true,
      keyProvider: 'env',        // 'env', 'file', or 'remote'
      keyProviderConfig: {
        envVar: 'BRI_ENCRYPTION_KEY'  // 64 hex chars (32 bytes)
      }
    }
  }
});
```

#### Data Directory Structure

Under the hood, hot-tier keys live in memory; documents evicted under memory pressure land in the cold tier (`cold/{TYPE_PREFIX}/{id}.jss`). There is **no** per-document `./docs/` tree on disk for the stock in-house backend.

```
data/
├── cold/
│   └── POST/              # Example: evicted POST_* keys as .jss files
├── wal/
│   └── 000001.wal
├── txn/
│   └── txn_abc1234.wal
└── snapshots/
    └── ...
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

Published package **`bri-db`** exposes default export **`bri`** (ESM). Prefer:

```javascript
import bri from 'bri-db';

const db = bri.connect({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 }
});
```

Await **backing READY** **before** synchronous contract tests or scripts that rely on READY:

```javascript
import { openLocalDatabase, openRemoteDatabase } from 'bri-db';

const dbLocal = await openLocalDatabase({ storeConfig: { dataDir: './data', maxMemoryMB: 256 } });
```

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

### Query Filtering

BRI supports multiple ways to filter documents when retrieving:

```javascript
// By ID
const user = await db.get.user('USER_abc1234');

// By query object (partial match)
const admin = await db.get.user({ role: 'admin' });

// By filter function
const adults = await db.get.userS(user => user.age >= 18);

// By array of IDs
const specificUsers = await db.get.userS(['USER_abc1234', 'USER_def5678']);

// Get all documents in a collection
const allUsers = await db.get.userS();
```

### Reactive Entity Methods

Retrieved documents are reactive entities with automatic change tracking. They provide the following methods:

- `save(saveBy?, tag?)`: Persist changes to the database
- `toObject()`: Convert to a plain JavaScript object
- `toJSON()`: Convert to a JSON-serializable object
- `toJSS()`: Convert to JSS format (preserves Date, RegExp, Map, Set, etc.)
- `.and.{field}`: Chainable population proxy for resolving references

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

BRI supports chainable population of referenced documents using the `.and` proxy:

```javascript
// Single population
const postWithAuthor = await post.and.author;

// Chained population (deeply nested)
const postWithAuthorAndFriends = await post.and.author.and.friends;

// Multiple fields can be populated in sequence
const fullPost = await post.and.author.and.comments.and.tags;

// Explicit populate method (alternative syntax)
const result = await db.get.post(postId).populate('author').populate('comments');
```

Note: The `.and` accessor returns a Promise that resolves to the entity with the specified field populated.

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

### Collection Identity Diagnostics

Bri derives each collection's durable storage identity from the
collection name. That identity is the `$ID` prefix and the plural
collection group namespace, so two logical collections cannot share it.
Collisions throw `COLLECTION_IDENTITY_COLLISION` at schema declaration,
write, read, or boot before ambiguous data can be served.

```javascript
db.diag.collectionIdentities();
db.diag.collectionIdentities(['alpha', 'alpineHa']);
// → [{ collection, storageIdentity, prefix, unique, conflicts }]
```

Explicit collection storage identities are not supported; Bri keeps the
existing derived-prefix contract and rejects collisions.

### Runtime Logging

Default Bri logs storage lifecycle events to the console for standalone
scripts. Embedded applications can capture structured events or silence
human stdout:

```javascript
const events = [];
const db = await openLocalDatabase({
  logger: {
    info: (event) => events.push(event),
    warn: (event) => events.push(event),
    error: (event) => events.push(event),
    debug: (event) => events.push(event)
  },
  storeConfig: { dataDir: './data', maxMemoryMB: 256 }
});

const quiet = await openLocalDatabase({
  logger: false,
  storeConfig: { dataDir: './test-data', maxMemoryMB: 64 }
});
```

### Middleware (Plugins)

BRI supports a middleware system for intercepting and extending CRUD operations:

```javascript
// Add custom middleware (chainable)
db.use(async (ctx, next) => {
  console.log(`${ctx.operation}.${ctx.type}`, ctx.args);
  await next();
  console.log('Result:', ctx.result);
}).use(anotherMiddleware);

// Middleware context includes:
// - ctx.operation: 'get', 'add', 'set', 'del'
// - ctx.type: collection name (e.g., 'user', 'userS')
// - ctx.args: operation arguments
// - ctx.opts: options object (mutable)
// - ctx.db: database reference
// - ctx.result: operation result (after next())
```

#### Middleware Manager

Access the middleware manager directly for more control:

```javascript
// Add middleware
db.middleware.use(fn);

// Remove specific middleware
db.middleware.remove(fn);

// Clear all middleware
db.middleware.clear();

// Check middleware count
console.log(db.middleware.count);
```

#### Built-in Middleware Plugins

Available from **`bri-db/engine`**:

```javascript
import {
  transactionMiddleware,
  loggingMiddleware,
  validationMiddleware,
  hooksMiddleware
} from 'bri-db/engine';

// Transaction middleware (enabled by default)
// Auto-injects txnId from db._activeTxnId

// Logging middleware
db.use(loggingMiddleware({ logResults: false }));

// Validation middleware — validators return arrays of errors (possibly async)
db.use(validationMiddleware({
  user: async (data) => (!data.email ? ['Email required'] : [])
}));

// Hooks middleware
const hooks = hooksMiddleware();
hooks.before('add', 'user', async (ctx) => {
  ctx.args[0].createdBy = 'system';
});
hooks.after('add', 'user', async (ctx) => {
  console.log('User created:', ctx.result.$ID);
});
db.use(hooks.middleware);
```

### Schema Validation

BRI validates schema-backed writes through **`bri-db/utils/schema`**. **`validate(schema, payload)` throws `BriValidationError`** on failure (`e.code` carries stable codenames):

```javascript
import validate from 'bri-db/utils/schema';

const userSchema = {
  name: { type: String, required: true },
  email: { type: 'email', required: true },
  age: { type: Number, required: false },
  role: { type: String, enum: ['admin', 'user', 'guest'] },
  profile: {
    type: Object,
    properties: {
      bio: { type: String, required: false },
      avatar: { type: String, required: false }
    }
  },
  tags: { type: Array, items: String }
};

try {
  const userData = { name: 'Alice', email: 'alice@example.com' };
  validate(userSchema, userData);
  await db.add.user(userData);
} catch (e) {
  console.error(e.name, e.code ?? e.message);
}
```

#### Supported Types

- `String`, `Number`, `Boolean`, `Date`, `Object`, `Array`
- `'email'` - String with email format validation
- `'ref'` - String reference (document ID)

#### Schema Options

- `type`: The data type (required)
- `required`: Whether the field is required (default: `true`)
- `enum`: Array of allowed values
- `get`: Transform function when reading
- `set`: Transform function when writing
- `properties`: Nested schema for Object types
- `items`: Type for Array items

### Vector + Graph v1

Bri ships a single-process, schema-driven substrate for vector search
and knowledge-graph traversal. Pure-JS HNSW under the hood, transactional
isolation via deferred linking, schema-scoped cancellation cascades.

```js
db.schema('memoryArtifact', {
  type:      { type: String, required: true },
  embedding: { type: 'vector', dims: 1536 },
  superseded_by_id: { type: 'ref', to: 'memoryArtifact', required: false },
  source_session_id: { type: String, cascadeOn: 'session' },
  $supersession: 'superseded_by_id'
});

const top5 = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .near(queryVec, 5)
  .confidence(0.7);

await alice.works_at(acme);                    // predicate proxy write
const employees = await acme.inverse.works_at; // inverse read
```

Capability docs (start with [docs/README.md](docs/README.md)):
- [vector.md](docs/vector.md) — `.near` / `.match` / `.combine`
- [graph.md](docs/graph.md) — `$edge` schemas, predicate proxy
- [transactions.md](docs/transactions.md) — `rec/fin/nop/pop` + cascade
- [schema-extensions.md](docs/schema-extensions.md) — full vocabulary
- [migration.md](docs/migration.md) — adopting in an existing project

Spec compliance is tracked in [todo/Vector.md](todo/Vector.md).

### JSS (JsonSuperSet) Serialization

BRI uses JSS for extended JSON serialization that preserves JavaScript types not supported by standard JSON:

```javascript
import jss from 'bri-db/utils/jss';

const data = {
  date: new Date(),
  pattern: /^hello/i,
  error: new Error('Something went wrong'),
  map: new Map([['key', 'value']]),
  set: new Set([1, 2, 3]),
  undef: undefined
};

// Serialize
const encoded = jss.stringify(data);

// Parse back (types are preserved)
const decoded = jss.parse(encoded);
console.log(decoded.date instanceof Date);  // true
console.log(decoded.pattern instanceof RegExp);  // true
```

#### Supported Types

- `Date` - Preserved as Date objects
- `RegExp` - Preserved with flags
- `Error` - Preserved with message and stack
- `Map` - Preserved as Map objects
- `Set` - Preserved as Set objects
- `undefined` - Explicitly preserved (unlike JSON)
- Circular references - Handled via pointer paths

#### Entity Conversion

Retrieved entities support JSS conversion:

```javascript
const user = await db.get.user(userId);

// Standard JSON (loses Date precision)
const json = user.toJSON();

// JSS format (preserves all types)
const jssData = user.toJSS();
```

## TypeScript Support

BRI includes complete TypeScript definitions in `index.d.ts`:

```typescript
import bri, { Database, ReactiveEntity, StoreConfig } from 'bri-db';

const db: Database = bri.connect({
  storeConfig: {
    dataDir: './data',
    maxMemoryMB: 256
  }
});

const user: ReactiveEntity = await db.add.user({ name: 'Alice' });
```

Key interfaces:
- `Database` - Main database interface with CRUD operations
- `ReactiveEntity` - Entity with save(), toObject(), toJSON(), toJSS()
- `StoreConfig` - Storage configuration options
- `MiddlewareContext` - Context passed to middleware functions
- `TransactionStatus` - Transaction state information

## Environment Variables

BRI respects the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `BRI_DATA_DIR` | Data directory path | `./data` |
| `BRI_MAX_MEMORY_MB` | Maximum memory for hot tier cache | `256` |
| `BRI_ENCRYPTION_KEY` | Encryption key (64 hex chars = 32 bytes) | *none* |
| `BRI_VECTOR_RNG_SEED` | Seed for HNSW level-pick RNG (deterministic snapshots/tests); omit in production for non-deterministic `Math.random` | *unset* |
| `BRI_VECTOR_WORKER` | Set to **`true`**, **`1`**, **`yes`**, or **`on`** (trimmed, case-insensitive); set to **`0`**, **`false`**, **`no`**, or **`off`** to force-disable inherited junk. When enabled, eagerly spawns the shared worker (`warmVectorWorkerFromEnv`) so `createWorkerVectorIndex()` skips cold-start. **`bri.connect`** / **`openLocalDatabase`** vector queries stay in-process — see [`src/workers/vector-worker-env.js`](src/workers/vector-worker-env.js) and [`docs/migration.md`](docs/migration.md). | unset (off) |

```bash
# Example usage
BRI_DATA_DIR=/var/lib/bri BRI_MAX_MEMORY_MB=512 node app.js

# With encryption enabled
BRI_ENCRYPTION_KEY=$(openssl rand -hex 32) node app.js
```

## Architecture

BRI is organized into four main modules under **`src/`**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        /src/client                               │
│         Public interface: .get.userS, user.and.friends          │
│              Query syntax, proxy handlers, bri.connect               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        /src/engine                               │
│            In-memory data handling & query fulfillment           │
│     ID generation, CRUD operations, reactive change tracking     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       /src/storage                               │
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
│                         /src/utils                               │
│              diff (change tracking) & jss (serialization)        │
└─────────────────────────────────────────────────────────────────┘
```

### Module Descriptions

- **src/client/** - Public surface: `.get.userS`, `user.and.friends` query wiring, proxies for collection access, and **`import bri from 'bri-db'; bri.connect(...)`** (plus READY helpers **`openLocalDatabase`** / **`openRemoteDatabase`** on the package root export).

- **src/engine/** - Core database engine handling in-memory data operations, query fulfillment, ID generation, CRUD operations, and reactive change tracking via proxies.

- **src/storage/** - File persistence layer with the InHouse storage adapter featuring hot tier (LRU cache), cold tier (JSON files), write-ahead log (WAL), periodic snapshots, and pub/sub for change notifications.

- **src/utils/** - Shared utilities including `diff` for change tracking and path operations, and `jss` (JsonSuperSet) for extended JSON serialization supporting Date, Error, RegExp, Map, Set, and circular references.

## Running Tests

This repository uses Jest for end-to-end suites under [`tests/e2e/`](tests/e2e/). The default `npm test` command ignores `scale.test.js` (use `npm run test:scale` for that file).

```bash
# Run all non-scale e2e suites
npm test

# Istanbul coverage (statements/branches/lines/functions)
npm run test:coverage

# Single suite
npm test -- tests/e2e/crud.test.js

# Scale-only suite
npm run test:scale
```

See [`tests/e2e/README.md`](tests/e2e/README.md) and [`tests/e2e/files.md`](tests/e2e/files.md) for the full manifest.

### Legacy Test Scripts

```bash
# Exercise the storage layer directly
node src/storage/test.js

# Exercise transaction helpers directly
node src/storage/transaction/test.js
```

## Quickstart (Bun)

A complete Bun-linked sample lives in **`quickstart-bun/`** (local dependency **`"bri": "file:.."`** resolved to this repository root):

```bash
cd quickstart-bun
bun install
bun run start
```

It walks through initialization, CRUD, relationships, subscriptions, and shutdown in one script. Published consumers should depend on **`bri-db`** (or **`npm link bri-db`** in their own repo). Details: [`quickstart-bun/README.md`](quickstart-bun/README.md).
