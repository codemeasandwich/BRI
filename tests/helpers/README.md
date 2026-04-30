# E2E helpers (`tests/helpers`)

Small modules imported **only from integration tests** under **`tests/e2e/`**:

- **`open-database.js`** — re-exports **`openLocalDatabase`**, **`openRemoteDatabase`**, and **`normalizedWsUrl`** from **`src/client/ready-connection.js`** so READY-first boot matches Docker and manual scripts.
- **`mock-bri-ws-rpc-server.js`** — lightweight **`ws`** harness for URL-based **`bri.connect`** tests without Bun.

Per-file API notes live in **[`files.md`](files.md)**. There is no production entrypoint here.
