## Directory Structure

```
tests/helpers/
├── README.md
├── files.md
├── mock-bri-ws-rpc-server.js
└── open-database.js
```

## Files

### `README.md`

High-level map of READY re-exports and the mock Bri WebSocket harness; pointers to **`files.md`**.

### `open-database.js`

Re-exports **`normalizedWsUrl`**, **`openLocalDatabase`**, and **`openRemoteDatabase`** from
**`../../src/client/ready-connection.js`** so every E2E suite shares the same READY-first entry that Docker
servers use.

### `mock-bri-ws-rpc-server.js`

Tiny **`ws`** `WebSocketServer` harness that echoes RPC frames in Bri's **`{ queryId, result }`** shape
for **`bri.connect({ url })`** integration tests without Bun or Docker.
