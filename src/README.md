# `src/` — published library packages

Runnable library code for **`bri-db`** lives here: client SDK, persistence, engine, cryptography, remote WebSocket façade, utilities, and optional Worker-thread offload.

- Consumers use **`import bri from 'bri-db'`** — root **`package.json`** `exports` map subpaths (`bri-db/client`, …) into this directory.
- **Do not** commit long-lived **`test-data-*`** directories here; ephemeral E2E output stays at repo root (**`tests/jest/global-teardown`** removes matching roots).

See **[`files.md`](files.md)** for a per-folder index.
