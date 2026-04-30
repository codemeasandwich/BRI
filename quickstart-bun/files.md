# Quickstart (Bun) — folder index

The **[`README.md`](README.md)** here is end-user-facing. This **`files.md`** lists every **tracked** artifact developers care about inside **`quickstart-bun/`**.

> Ephemeral `./data/` (WAL/snapshots produced by **`bun run start`**) is **gitignored** at **`quickstart-bun/data`**; it does not appear in the tree below.

## Directory Structure

```
quickstart-bun/
├── README.md
├── bun.lockb
├── package.json
└── index.js
```

## Files

### `README.md`

How to **`bun install`** / **`bun run start`**, expectations around **`file:..` → parent repo**, feature checklist, shutdown behaviour.

### `package.json`

Local dependency shim (`"bri": "file:.."`) pinning this sample to the checkout root **`index.js`** / **`package.json`** exports—not the tarball name **`bri-db`**.

### `index.js`

Single-file tour: initialization, CRUD patterns, subscriptions, teardown. Invoked via **`npm run start` / bun script** definitions in **`package.json`**.

### `bun.lockb`

Binary lockfile for reproducible **`bun install`** installs of the sample’s transitive dependencies (currently just the **`bri`** file link).
