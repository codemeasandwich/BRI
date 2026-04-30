# Local “kitchen sink” examples

This directory is a **standalone walkthrough** of the public Bri client API using an **in-process** database. It is intended for operators and library authors who want to see every CRUD, query, relationship, subscription, and transaction pattern in one place—without Docker, without a WebSocket server, and without reaching for the Jest tree.

## What you get

- **Twenty numbered scenarios** split across six modules (`01-crud.js` … `06-advanced.js`).
- **Shared console helpers** (`helpers.js`) for readable section headers and banners.
- **Deterministic storage** under `./data/kitchen-sink` relative to the **repository root** (create that path on first run; add it to `.gitignore` locally if you experiment with custom locations).
- **READY-first bootstrap** via `openLocalDatabase()` from `../../src/client/ready-connection.js`, matching how the Docker server and integration tests open a local store.

These scripts are **not** published as part of the `bri-db` tarball; they assume you are running from a git checkout so deep imports into `src/` resolve.

## Prerequisites

- **[Bun](https://bun.sh/)** is the documented runtime (`bun docker/examples/index.js`).
- Alternatively, run with **Node** using your usual ESM flags if you mirror the import graph (Bun is what the file headers comment today).

## How to run

From the **repository root**:

```bash
bun docker/examples/index.js
```

`index.js` orchestrates all modules in order and calls `db.disconnect()` at the end.

### Run a single module (advanced)

Each `01-*.js` … `06-*.js` file exports async runners such as `runCrudExamples(db)`. There is no separate CLI for per-file execution; import the runner from a small scratch script or temporarily edit `index.js` if you want isolation during debugging.

## Module map

| File | Focus |
|------|--------|
| `01-crud.js` | Create, read (single / collection), object and function filters |
| `02-arrays-update.js` | Bulk ID fetch, partial updates, replace semantics |
| `03-delete-relations.js` | Deletes, relations, `.and` population basics |
| `04-populate-subs.js` | Populate chains, pub/sub |
| `05-transactions.js` | `rec` / `fin` / `nop` / `pop`, transaction visibility |
| `06-advanced.js` | Reactive helpers, special types, composite patterns |

See [`files.md`](files.md) for export-level detail.

## Relation to `docker/remote/`

[`docker/remote/`](../remote/) runs the **same** scenario functions against **`openRemoteDatabase`** (WebSocket to `docker/server`). Use **local examples** to debug storage and engine behaviour; use **remote** once you need RPC, framing, or multi-process semantics.

## Relation to published consumers

Application code should depend on **`bri-db`** exports (`bri.connect`, `openLocalDatabase`, …) rather than copying these deep paths. The examples import `../../src/client/...` so this repo stays self-contained before `npm pack`.

## Troubleshooting

- **`openLocalDatabase` hangs or throws on store init** — Ensure `storeConfig.dataDir` is writable and `maxMemoryMB` is set (the sample uses `64`).
- **`MODULE_NOT_FOUND` for `src/client`** — Run from the repo root, not from inside `docker/examples/`, so relative `../../src/...` resolves.
- **Stale data** — Remove `./data/kitchen-sink` manually if you want a clean slate between runs.
