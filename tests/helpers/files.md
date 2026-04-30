## Directory Structure

```
tests/helpers/
├── files.md
├── mock-bri-ws-rpc-server.js
└── open-database.js
```

## Files

### `open-database.js`

Re-exports **`normalizedWsUrl`**, **`openLocalDatabase`**, and **`openRemoteDatabase`** from
`client/ready-connection.js` so every E2E suite shares the same READY-first entry that Docker
servers use.

### `mock-bri-ws-rpc-server.js`

Tiny **`ws`** `WebSocketServer` harness that echoes RPC frames in Bri's **`{ queryId, result }`** shape
for **`bri.connect({ url })`** integration tests without Bun or Docker.
