# Remote “kitchen sink” examples (WebSocket)

This directory mirrors [`docker/examples/`](../examples/) **module-for-module**, but every call goes through **`openRemoteDatabase()`** so the database engine runs **behind the Bun WebSocket server** in [`docker/server/`](../server/).

## Why it exists

- Proves the **wire protocol and RPC surface** match the local API (same method names, payloads, and READY queueing discipline).
- Gives a **manual reproducer** when remote-only bugs appear (connection lifecycle, subscription fan-out, txn batching over RPC).
- Keeps example code **parallel** to local examples: same `01-crud.js` … `06-advanced.js` structure and `helpers.js` output.

## Prerequisites

1. A running server on **`ws://localhost:3000`** (default used in `index.js`).
2. **Bun** on the client side for the documented command line.

### Start the server

From the repository root (in a separate terminal):

```bash
bun docker/server/index.js
```

Or bring up the stack described in the parent [`docker/README.md`](../README.md) (`docker compose`).

## How to run

With the server listening:

```bash
bun docker/remote/index.js
```

`index.js`:

- Banner + scenario dispatch (same order as local examples).
- **`await openRemoteDatabase('ws://localhost:3000')`** — path normalization and `/api/ape` handling follow `ready-connection.js` (see package `bri-db` docs for URL rules).
- Disconnects the client at the end so the server process can stay up for repeated runs.

## Custom endpoints

Pass a different WS URL by editing `docker/remote/index.js` or by wrapping `openRemoteDatabase` in your own driver script. Production clients typically use **`bri.connect({ url })`** or **`createRemoteDatabasePromise`** from **`bri-db/remote`** rather than this folder’s deep imports.

## Debugging checklist

| Symptom | Likely cause |
|---------|----------------|
| `ECONNREFUSED` | Server not running or wrong port |
| Hang after connect | Server never reached READY (check server logs for storage init) |
| RPC errors with opaque payloads | Version skew between client checkout and server binary—run both from same commit |

Deep import paths into `../../src/client/` assume execution from a **git checkout** at the repo root, same as [`docker/examples/`](../examples/).

## See also

- [`files.md`](files.md) — per-file responsibilities and exports.
- [`docker/server/README.md`](../server/README.md) — transport, env vars, handshake.
