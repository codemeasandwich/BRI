# Observability — what gets logged, where to look

Bri's substrate-style philosophy means observability is built around
the existing logging surface plus a small set of diagnostic accessors
on the engine modules. There is no metrics SDK; every signal below is
read from process logs, return values, or stat methods.

## Process logs

The engine prints connection/recovery/snapshot events to `stdout`:

```
Snapshot: No snapshot found
InHouse Store: Recovered
Snapshot: Scheduler started (every 30 minutes)
InHouse Store: Connected and ready
BRI: Connected to storage
```

Nothing is logged per-write or per-search by default. To inspect query
behaviour, register the built-in `loggingMiddleware` exported from **`bri-db/engine`**
(subpath [`bri-db/engine/middleware.js`](../engine/middleware.js) also resolves via `package.json` exports):

```js
import { loggingMiddleware } from 'bri-db/engine';
db.use(loggingMiddleware({ prefix: '[bri]', logResults: false }));
```

Every CRUD op logs `{operation}.{collection}` plus duration in ms.

## Diagnostic accessors

Each index module exposes a `stats()` for pulling current state:

| Accessor | Returns |
|---|---|
| `VectorIndex.stats()` | `{ count, capacity, dims, metric, memoryBytes, entryLevel, M, efConstruction, efSearch }` |
| `SecondaryIndexManager.stats()` (if implemented) | per-index entry counts |
| `GraphIndex.stats()` | per-edge-collection adjacency sizes |

Use these in test assertions or dev tooling — `process.hrtime.bigint()`
+ `stats()` is enough to do ad-hoc latency profiling without an
external APM.

## WAL inspection

Physical line shape (see [`serializeEntry()`](../storage/wal/entry.js)):

```
{timestamp}|{pointer}|{entryJSON}
```

Use [`storage/wal/record-types.js`](storage/wal/record-types.js) for vocabulary. With encryption off, **`grep VECTOR_ADD data/wal/000001.wal`** still matches the literal token inside the JSON payload.

```bash
grep VECTOR_ADD data/wal/000001.wal
```

When `BRI_ENCRYPTION_KEY` is set, entries are encrypted — use the WAL reader (`storage/wal/reader.js`) which decrypts in-place.

## Worker diagnostics (spec §3.2)

The shared index-worker exposes an op counter:

```js
import { workerDiagnostics } from 'bri-db/workers';
const { opCount } = await workerDiagnostics();
```

Used by `tests/e2e/worker.test.js` to verify the worker is actually
processing requests rather than silently falling through to a hidden
in-process path. Useful in scale tests too — `opCount` increments per
handled request, so you can confirm all bulk inserts crossed the
boundary.

## Recovery / startup signals

Recovery prints `InHouse Store: Recovered` once snapshot + WAL replay
completes; it prints the chosen format version (`Snapshot v3 detected`)
on snapshot load. If WAL replay fails, the recovery layer throws
`BriRecoveryError` with code `WAL_INDEX_REPLAY_FAILED` — catch this at
the boot path to surface the problem rather than running on partial
state.

## Production checklist

| Concern | What to watch | Where |
|---|---|---|
| Snapshot freshness | `Snapshot: Saved` log lines | stdout |
| WAL growth | segment files in `data/wal/` | filesystem |
| Vector index size | `idx.stats().memoryBytes` | engine accessor |
| Failed validations | `BriValidationError` thrown — catch and log at the boundary | application code |
| Cascade deletes | `cascade.session(id)` returns `{deleted, byCollection}` — log it | application code |

There is no built-in alerting, no metrics endpoint, no distributed
tracing hookup. v2 may add a `db.diag` namespace that aggregates the
above into a single object; v1 keeps the surface minimal so the
embedding in larger systems is unopinionated.
