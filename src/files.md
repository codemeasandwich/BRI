## Directory structure

```
src/
├── README.md
├── files.md
├── client/
├── crypto/
├── engine/
├── remote/
├── storage/
├── utils/
└── workers/
```

## Packages

Each subdirectory is documented in its own **`README.md`** / **`files.md`** where present.

### `client/`

Synchronous SDK (**`bri.connect`**), **`deferDatabase`**, proxy routing, **`openLocalDatabase` / ready-connection** façade for servers and tests.

### `crypto/`

At-rest encryption primitives and key providers; used primarily from **`storage`**.

### `engine/`

In-memory engine — registry, **`VectorIndex`**, graph, **`QueryPlanner`**, middleware, predicates.

### `remote/`

**`createRemoteDatabasePromise`** WebSocket façade after **`OPEN`**.

### `storage/`

**`createStore`** / in-house adapters, WAL, snapshots, cold/hot tiers, transaction manager internals.

### `utils/`

**`jss`**, **`diff`**, **`schema`** — portable helpers referenced by **`client`** and **`engine`**.

### `workers/`

**`worker_threads`** index worker shim and **`vector-worker-env`** env parsing for optional offload.
