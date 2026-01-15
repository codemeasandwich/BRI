## Directory Structure

```
transaction/
├── manager.js
├── txn-operations.js
├── txn-undo.js
└── txn-recovery.js
```

## Files

### `manager.js`

Main TransactionManager class coordinating transaction lifecycle.

**Class: TransactionManager**
- `rec()` - Start new transaction, returns txnId
- `fin(txnId)` - Commit and return squashed entries
- `nop(txnId)` - Cancel transaction
- `getTxn(txnId)` - Get transaction state
- `hasTxn(txnId)` - Check if transaction exists
- `status(txnId)` - Get transaction status
- `listPending()` - List pending transaction IDs

### `txn-operations.js`

CRUD operations within transactions.

**Methods:**
- `set(txnId, key, value)` - Set document
- `get(txnId, key)` - Get from shadow state
- `rename(txnId, oldKey, newKey)` - Rename key
- `sAdd(txnId, setName, member)` - Add to set
- `sMembers(txnId, setName)` - Get set members
- `sRem(txnId, setName, member)` - Remove from set

### `txn-undo.js`

Undo functionality for transactions.

**Methods:**
- `pop(txnId)` - Undo last action
- `truncateLastLine(filePath)` - Remove last WAL line

### `txn-recovery.js`

Recovery and squash logic.

**Methods:**
- `squashActions(txn)` - Compress actions to final state
- `recover()` - Restore pending transactions from disk
