## Directory Structure

```
tests/
├── README.md
├── files.md         # This index — keep subfolder README/files.md authoritative for detail
├── fixtures/        # schemas, embeddings, triples — README.md + files.md
├── helpers/         # READY re-exports, mock Bri WS harness — README.md + files.md
├── jest/            # globalTeardown — README.md + files.md
└── e2e/             # Jest integration suites — README.md + files.md
```

## Files

### `README.md`

Top-level testing philosophy and how to run **`npm test`** / coverage from the repo root.

### `files.md`

This directory index. Individual subtrees carry their own **`README.md`** (orientation) and **`files.md`** (file-by-file manifest) so pre-commit documentation checks stay accurate.

### `fixtures/`

Shared schema + embedding + triple fixtures imported by E2E tests and **`examples/`** scripts.

### `helpers/`

See **[`helpers/README.md`](helpers/README.md)** — stable imports for **`openLocalDatabase`** / **`openRemoteDatabase`**.

### `jest/`

See **[`jest/README.md`](jest/README.md)** — **`globalTeardown`** cleanup of **`test-data-*`** roots.

### `e2e/`

All **`*.test.js`** integration suites; manifest in **[`e2e/files.md`](e2e/files.md)**.
