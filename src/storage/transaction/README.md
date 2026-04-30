# Transaction

Long-lived transactions with ACID-like semantics.

## Overview

The transaction manager provides isolated, durable transactions with commit, rollback, and undo capabilities. Each transaction has its own WAL file for durability.

## API

- `rec()` - Start recording a new transaction
- `fin(txnId)` - Commit transaction (finalize)
- `nop(txnId)` - Cancel transaction (no-op)
- `pop(txnId)` - Undo last action

## Usage

```javascript
import { TransactionManager } from './transaction/manager.js';

const txnMgr = new TransactionManager('./data');

const txnId = txnMgr.rec();
txnMgr.set(txnId, 'user_123', userData);
txnMgr.sAdd(txnId, 'userS', 'user_123');

// Commit
const result = await txnMgr.fin(txnId);

// Or rollback
await txnMgr.nop(txnId);
```

## Features

- Shadow state isolation (reads see uncommitted changes)
- Per-transaction WAL for durability
- Action squashing on commit
- Undo/pop for individual actions
- Crash recovery of pending transactions
