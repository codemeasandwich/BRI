# Client

Public database interface with proxy-based API.

## Overview

The client provides the user-facing API for BRI, enabling intuitive collection access like `db.get.userS()` and `db.add.user()`.

## Usage

```javascript
import { createDB, getDB } from 'bri';

// Create new instance
const db = await createDB({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 }
});

// Or use singleton
const db = await getDB();

// CRUD operations
const user = await db.add.user({ name: 'Alice', role: 'admin' });
const users = await db.get.userS({ role: 'admin' });
const found = await db.get.user('USER_abc1234');

// Update via proxy
found.name = 'Bob';
await found.save();

// Delete
await db.del.user(user.$ID);

// Transactions
const txnId = db.rec();
await db.add.user({ name: 'Charlie' });
await db.add.post({ title: 'Hello' });
await db.fin(); // commit
// or db.nop(); // rollback

// Middleware
db.use(async (ctx, next) => {
  console.log('Before:', ctx.operation, ctx.type);
  await next();
  console.log('After:', ctx.result);
});
```

## Configuration

```javascript
const db = await createDB({
  storeType: 'inhouse',
  storeConfig: {
    dataDir: './data',
    maxMemoryMB: 256,
    fsyncMode: 'batched'
  }
});
```

Environment variables:
- `BRI_DATA_DIR` - Data directory (default: ./data)
- `BRI_MAX_MEMORY_MB` - Memory limit (default: 256)
