## Directory Structure

```
docker/
├── .env.example
├── Dockerfile
├── README.md
├── TODO.md
├── docker-compose.yml
├── examples/
│   ├── helpers.js
│   ├── 01-crud.js
│   ├── 02-arrays-update.js
│   ├── 03-delete-relations.js
│   ├── 04-populate-subs.js
│   ├── 05-transactions.js
│   ├── 06-advanced.js
│   └── index.js
├── remote/
│   ├── helpers.js
│   ├── 01-crud.js
│   ├── 02-arrays-update.js
│   ├── 03-delete-relations.js
│   ├── 04-populate-subs.js
│   ├── 05-transactions.js
│   ├── 06-advanced.js
│   └── index.js
└── server/
    ├── handlers.js
    ├── utils.js
    ├── index.js
    └── package.json
```

## Files

### `.env.example`

Environment variable template for Docker configuration.

### `Dockerfile`

Container definition for BRI server deployment.

### `README.md`

Docker setup and usage documentation.

### `TODO.md`

Development task tracking for Docker integration.

### `docker-compose.yml`

Docker Compose service configuration for BRI server.

### `examples/`

Local BRI usage examples using `openLocalDatabase` from `client/ready-connection.js` (or **`bri.connect`**). Demonstrates all BRI API features.

### `remote/`

Remote client examples using WebSocket (`bri.connect({ url })` or `openRemoteDatabase`). Functionally parallels `docker/examples/` (same numbered modules over the network).

### `server/`

WebSocket RPC server for remote BRI access.
