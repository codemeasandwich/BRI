# Transactions — vector + graph atomicity

This page covers what `db.rec()` / `db.fin()` / `db.nop()` / `db.pop()`
guarantee for vector + graph state, the deferred-linking model that
makes those guarantees cheap to implement, and the cancellation cascade
contract from spec §2.8.

## The four lifecycle methods

```js
const txnId = db.rec({ sessionId: 'SESS_abc' }); // start; tag with session
await db.add.memArt({ ... });                    // staged
await db.add.kgTriple({ ... });                  // staged
await db.fin();                                   // commit everything
```

| Method | Effect |
|---|---|
| `rec(opts?)` | Open a transaction. Returns the txnId; sets `db._activeTxnId`. Optional `{sessionId}` tags the txn so a session-scoped cascade can identify and roll it back. |
| `fin(txnId?)` | Commit. Document writes flush from the txn shadow into committed state; vector index pending buckets flush into the committed index. |
| `nop(txnId?)` | Cancel. All staged document writes are dropped. Every vector index drops its pending bucket for the txn — staged adds leave no trace. |
| `pop(txnId?)` | Undo the most recent staged action. If it was a SET on a vector-bearing collection, the most recent staged op for that `$ID` is also dropped. |

## Vector index transaction model — deferred linking

Per spec §7.1 the vector index uses a deferred-linking model rather than
tombstone-marking the committed graph. Inside an open transaction, vector
ops go into `_pending` (`Map<txnId, Array<{op, id, vec}>>`) — they are
NOT linked into the searchable HNSW topology.

| Operation | Behaviour |
|---|---|
| `searchInTxn(query, k, txnId)` | Merges committed search with the pending log entries for the txn. The writer sees its own buffered changes; outside-txn callers don't. |
| `commit(txnId)` | Flushes pending ops to the committed index — `add` calls `insertNode`, `remove` calls `dropNode`. Idempotent. |
| `rollback(txnId)` | Discards the pending bucket entirely — O(1). |
| `popStaged(txnId, id)` | Drops the most recent pending op for a specific `$ID`. |

Why deferred linking and not tombstones: the committed index never
carries half-applied state, so `nop()` is O(1) (drop the bucket) and
crash recovery is automatically pre-txn (the committed buffer was never
touched). The trade-off — slightly larger working set during long
transactions — is acceptable at v1 scales (spec §7.1 explicitly picks
this).

## What `nop()` / `pop()` guarantee

- **`nop()` leaves the index bit-identical to the pre-`rec()` state.**
  The committed buffer was never modified by staged ops; the pending
  bucket is dropped.
- **`pop()` rolls back the most recent staged action** including the
  vector op that piggy-backs on a SET. A single `db.add` records SET +
  SADD in the txn — undoing the full add takes two `pop()` calls.
- **Crash mid-transaction recovers to the pre-transaction state.**
  Committed snapshot + WAL replay cover only committed actions; staged
  state lives in process memory and dies with the process.

The recovery test (`tests/e2e/recovery.test.js`) spawns a child process,
opens a txn, stages docs, and SIGKILLs the child. The parent re-opens
the data dir and asserts only the committed baseline is visible.

## Cancellation cascade contract (spec §2.8)

```js
await db.cascade.session(sessionId);
```

When `cascade.session('SESS_X')` runs:

1. If `db._activeTxnId` exists AND its sessionId tag === `'SESS_X'`, the
   cascade calls `db.nop()` to roll back the staged writes. Other
   sessions' active transactions are NOT touched.
2. Then iterates every collection that declared a field with
   `cascadeOn: 'session'` and deletes the rows whose field value matches
   `'SESS_X'`. Reads + deletes bypass the active txn (default
   `txnId: null`) so a different session's staged writes are invisible
   and intact.
3. Each delete goes through the standard `db.del.{collection}` path so
   vector + graph + secondary indexes all sync as part of the cascade.

The cancellation cascade is a §10 NON-NEGOTIABLE — the V8 spec marks it
as one of two invariants that absolutely must work. Tests:
`tests/e2e/cascade.test.js` covers each branch; `tests/e2e/scenarios.test.js`
exercises it end-to-end.

## WAL record types (spec §3.3)

The WAL records every committed write as a typed action. Implementation
file: [storage/wal/record-types.js](../src/storage/wal/record-types.js).

| Type | Carries |
|---|---|
| `SET` | document body (insert or replace) |
| `DELETE` | document deletion |
| `RENAME` | document `$ID` change |
| `SADD` / `SREM` | legacy set-collection ops |
| `INDEX_INSERT` / `INDEX_REMOVE` / `INDEX_UPDATE` | secondary index deltas |
| `VECTOR_ADD` / `VECTOR_REMOVE` | vector index deltas |
| `VECTOR_COMMIT_TXN` / `VECTOR_ROLLBACK_TXN` | txn lifecycle markers |

Document records continue to be the primary persistence channel; vector
and index records are emitted alongside for observability and for v2
worker-thread cross-process replication. Old WALs replay without
modification — the index-level types are additive.
