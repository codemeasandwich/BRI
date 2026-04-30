## Directory Structure

```
docker/
├── .env.example
├── Dockerfile
├── README.md
├── TODO.md
├── docker-compose.yml
├── examples/
│   ├── README.md
│   ├── helpers.js
│   ├── 01-crud.js
│   ├── 02-arrays-update.js
│   ├── 03-delete-relations.js
│   ├── 04-populate-subs.js
│   ├── 05-transactions.js
│   ├── 06-advanced.js
│   └── index.js
├── remote/
│   ├── README.md
│   ├── helpers.js
│   ├── 01-crud.js
│   ├── 02-arrays-update.js
│   ├── 03-delete-relations.js
│   ├── 04-populate-subs.js
│   ├── 05-transactions.js
│   ├── 06-advanced.js
│   └── index.js
└── server/
    ├── README.md
    ├── crud.js
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

Local BRI kitchen-sink examples using **`openLocalDatabase`** (**[`src/client/ready-connection.js`](../src/client/ready-connection.js)**). Detailed orientation: **`examples/README.md`**. Companion index: **`examples/files.md`**.

### `remote/`

Remote client examples via WebSocket (**`openRemoteDatabase`**). Mirrors **`examples/`** over the wire; see **`remote/README.md`**. Companion index: **`remote/files.md`**.

### `server/`

WebSocket RPC server for remote Bri access. Operational guide **`server/README.md`**; companion index **`server/files.md`**.
