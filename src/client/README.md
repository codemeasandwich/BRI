# Client

Public database interface with proxy-based API.

## Overview

The client provides the user-facing API for BRI, enabling intuitive collection access like `db.get.userS()` and `db.add.user()`.

## Usage

```javascript
import bri from 'bri-db';

const db = bri.connect({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 }
});

// READY before sync throws/tests: await openLocalDatabase({ storeConfig: { … } })
// Examples: await db.add.user(...), db.rec()/db.fin(), db.use(...)
```

## Configuration

```javascript
const db = bri.connect({
  storeType: 'inhouse',
  storeConfig: {
    dataDir: './data',
    maxMemoryMB: 256,
    fsyncMode: 'batched'
  }
});
```

Environment variables:
- `BRI_DATA_DIR` — Data directory (default: ./data)
- `BRI_MAX_MEMORY_MB` — Memory limit (default: 256)
- `BRI_VECTOR_RNG_SEED` — Deterministic vector index RNG for tests (optional)
- `BRI_VECTOR_WORKER` — Enable with **`true`/`1`/`yes`/`on`** (trimmed); **`0`/`false`/`no`/`off`** forces off. Warms the Worker thread for `createWorkerVectorIndex`; vector queries from **`bri.connect`** / **`openLocalDatabase`** (e.g. `.where.near`) stay in-process (see migration docs)
