## Directory Structure

```
workers/
├── index-worker.js
├── index-worker-host.js
└── vector-worker-env.js
```

## Files

### `index-worker.js`

Worker-thread entry: `VectorIndex` operations over `parentPort`; `ops` table dispatches `vector.*` and `diag.opCount`; serializes errors back to the host.

### `index-worker-host.js`

Main-thread shim — spawns the worker, correlates request/response ids, exposes `WorkerVectorIndex`, `createWorkerVectorIndex`, `workerDiagnostics()`, `disposeWorker()` for opt-in offload.

### `vector-worker-env.js`

Small, **`worker_threads`-free** module that parses **`BRI_VECTOR_WORKER`** (trimmed, whitelist tokens: `true`/`1`/`yes`/`on`; explicit disables: `0`/`false`/`no`/`off`) so `createDB` can gate the dynamic import of the host shim (`isVectorWorkerWarmRequestedFromEnv`).
