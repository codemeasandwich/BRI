## Directory Structure

```
workers/
├── index-worker.js
└── index-worker-host.js
```

## Files

### `index-worker.js`

Worker-thread entry: `VectorIndex` operations over `parentPort`; `ops` table dispatches `vector.*` and `diag.opCount`; serializes errors back to the host.

### `index-worker-host.js`

Main-thread shim — spawns the worker, correlates request/response ids, exposes `WorkerVectorIndex`, `createWorkerVectorIndex`, `workerDiagnostics()`, `disposeWorker()` for opt-in offload.
