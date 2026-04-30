# Bun WebSocket RPC server

This folder implements the **reference Bri-over-WebSocket gateway** used by docker-compose and by [`docker/remote/`](../remote/) smoke scripts. One long-lived **`openLocalDatabase`** instance backs every connected client; each WebSocket carries JSON-framed RPC that maps 1:1 onto the familiar `db.get.*` / `db.add.*` / `db.sub.*` surface.

## Runtime

The entrypoint is **`index.js`**, written for **[Bun](https://bun.sh/)**:

```bash
# From repo root
bun docker/server/index.js
```

It calls `Bun.serve` with a WebSocket upgrade path (see implementation for exact route naming—clients default to **`ws://host:PORT`** and the shared normalizer aligns paths with **`/api/ape`** conventions).

### Why Bun here

Node could host the same protocol with a different HTTP stack; this directory optimizes for a **single binary** demo that matches Compose images and CI expectations. Behavioural truths live in **`handlers.js`** (`handleRPC`) and **`crud.js`**, not in Bun specifics.

## Environment variables

| Variable | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3000` | Listening TCP port |
| `DATA_DIR` | `/data` | Persistent WAL / snapshot root inside containers; override locally (e.g. `./data/docker-server`) for dev |
| `MAX_MEMORY_MB` | `256` | Hot-tier memory budget forwarded to **`openLocalDatabase`** |
| `ENCRYPTION_KEY` | _(unset)_ | Optional 64-hex-char AES-GCM key for encrypted stores |
| `AUTH_REQUIRED` | `false` | When `true`, connection handshake enforces authentication (server logs describe failures) |

## Architecture sketch

```
Client (bri-db remote) ──WS JSON RPC──► index.js ──► handleRPC/handlers.js
                                                   └── crud.js (collection ops)
                                                   └── openLocalDatabase (src/client)
```

- **`utils.js`** — connection bookkeeping, serialization helpers shared with handlers.
- **`handlers.js`** — routes RPC verb families (`db/add/...`, `db/sub/...`, txn ops).
- **`package.json`** — workspace metadata when the Docker image builds this subtree in isolation.

## Operating notes

- **Single database** — all clients share one engine instance; multi-tenant isolation is *not* a goal of this reference server.
- **Logs** — init prints data dir, RAM budget, encryption status; augment for your deployment if you fork the entrypoint.
- **Clean shutdown** — send SIGTERM; upstream Bri closes snapshots/WAL politely when `disconnect` fires.

For image build, Compose wiring, and client snippets, see the parent **[`docker/README.md`](../README.md)**.

## Documentation index

[`files.md`](files.md) lists each source file with export-level commentary.
