# Adapters

Storage backend implementations.

## Overview

Adapters provide a unified interface for different storage backends. Currently supports the InHouse adapter with hot/cold tiering.

## InHouse Adapter

Memory-first storage with WAL durability:

```javascript
import { InHouseAdapter } from './adapters/inhouse.js';

const adapter = new InHouseAdapter({
  dataDir: './data',
  maxMemoryMB: 256
});

await adapter.connect();

// CRUD
await adapter.set('user_123', userData);
const data = await adapter.get('user_123');

// Transactions
const txnId = adapter.rec();
adapter.set('user_123', newData, { txnId });
await adapter.fin(txnId); // commit
// or await adapter.nop(txnId); // rollback

await adapter.disconnect();
```

## Features

- Hot tier (memory) + cold tier (files)
- Write-ahead log for durability
- Periodic snapshots
- Transaction support
- Pub/sub for change notifications
