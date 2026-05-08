# Observability — what gets logged, where to look

Bri's substrate-style philosophy means observability is built around
a small logger boundary plus diagnostic accessors on the database and
engine modules. There is no metrics SDK; every signal below is read
from structured log events, default process logs, return values, or
stat methods.

## Process logs

By default, local Bri prints connection/recovery/snapshot events to
`stdout` so one-file scripts remain easy to operate:

```
Snapshot: No snapshot found
InHouse Store: Recovered
Snapshot: Scheduler started (every 30 minutes)
InHouse Store: Connected and ready
BRI: Connected to storage
```

Embedded applications can replace that console behavior with a structured
logger:

```js
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
```

Each event has this stable shape:

```js
{
  event: 'storage.snapshot.created',
  level: 'info',
  severity: 'info',
  message: 'Snapshot: Created at WAL line 42',
  metadata: { walLine: 42, path: 'data/snapshot.jss' },
  error: undefined
}
```

Passing `logger: false` silences Bri's human stdout/stderr output for
tests and embedded production runtimes. Passing a custom logger also
disables raw console output by default; the application owns event
routing from there.

Nothing is logged per-write or per-search by default. To inspect query
behaviour, register the built-in `loggingMiddleware` exported from **`bri-db/engine`**
(subpath [`bri-db/engine/middleware.js`](../src/engine/middleware.js) also resolves via `package.json` exports):

```js
import { loggingMiddleware } from 'bri-db/engine';
db.use(loggingMiddleware({ prefix: '[bri]', logResults: false }));
```

Every CRUD op logs `{operation}.{collection}` plus duration in ms.

## Diagnostic accessors

The public database diagnostic namespace exposes collection identity
state:

```js
db.diag.collectionIdentities();
db.diag.collectionIdentities(['alpha', 'alpineHa']); // preflight names
```

Rows include `{ collection, storageIdentity, prefix, unique, conflicts }`.
The optional argument projects names without registering them, so tools
can preflight a schema before calling `db.schema()` or writing data.

The vector index exposes `stats()` for pulling current state:

| Accessor | Returns |
|---|---|
| `VectorIndex.stats()` | `{ count, capacity, dims, metric, memoryBytes, entryLevel, M, efConstruction, efSearch }` |

Secondary and graph index state is persisted and verified through the
database APIs, snapshots, WAL replay, and collection identity diagnostics;
they do not currently expose a public `stats()` method. Use
`process.hrtime.bigint()` plus the public query surfaces for ad-hoc
latency profiling without an external APM.

## WAL inspection

Physical line shape (see [`serializeEntry()`](../src/storage/wal/entry.js)):

```
{timestamp}|{pointer}|{entryJSON}
```

Use [`storage/wal/record-types.js`](../src/storage/wal/record-types.js) for vocabulary. With encryption off, **`grep VECTOR_ADD data/wal/000001.wal`** still matches the literal token inside the JSON payload.

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

Recovery emits `storage.inhouse.recovered` once snapshot + WAL replay
completes. Snapshot load/create events use `storage.snapshot.*`, WAL
replay events use `storage.wal.*`, and collection identity registration
uses `collection.identity.registered`. If WAL replay fails, the recovery
layer throws `BriRecoveryError` with code `WAL_INDEX_REPLAY_FAILED`; if
persisted collection identity state is ambiguous it throws
`BriRecoveryError` with code `COLLECTION_IDENTITY_COLLISION`.

Encrypted stores route key-provider lifecycle through the same logger
boundary. Remote key-provider retry failures emit
`crypto.key_provider.fetch_failed`; background refresh failures emit
`crypto.key_manager.refresh_failed` and keep using the cached key. Passing
`logger: false` or a custom logger suppresses the old direct terminal
warnings for these encrypted boot and refresh paths too.

## Production checklist

| Concern | What to watch | Where |
|---|---|---|
| Snapshot freshness | `storage.snapshot.created` | logger/default stdout |
| WAL growth | segment files in `data/wal/` | filesystem |
| WAL replay | `storage.wal.replayed` | logger/default stdout |
| Collection identity conflicts | `COLLECTION_IDENTITY_COLLISION` | `db.schema`, write/read paths, or boot |
| Encryption key-provider retries | `crypto.key_provider.fetch_failed` | logger/default stderr |
| Encryption key refresh failures | `crypto.key_manager.refresh_failed` | logger/default stderr |
| Vector index size | `idx.stats().memoryBytes` | engine accessor |
| Failed validations | `BriValidationError` thrown — catch and log at the boundary | application code |
| Cascade deletes | `cascade.session(id)` returns `{deleted, byCollection}` — log it | application code |

There is no built-in alerting, no metrics endpoint, no distributed
tracing hookup. The logger boundary is intentionally dependency-free so
applications can bridge Bri events into whatever logging, metrics, or
test capture system they already use.
