# Deployment: Docker Container with Bun and API-Ape

## Overview

Deploy BRI as a standalone database server in a Docker container, running on Bun runtime with API-Ape v3/v4 as the HTTP interface. This enables BRI to be used as a network-accessible database service rather than just an embedded library.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     BRI Server Container                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    API-Ape v4 Layer                       │   │
│  │  REST API • WebSocket • Authentication • Rate Limiting    │   │
│  └───────────────────────────┬──────────────────────────────┘   │
│                              │                                   │
│  ┌───────────────────────────▼──────────────────────────────┐   │
│  │                    BRI Database Engine                    │   │
│  │  Hot Tier • Cold Tier • WAL • Snapshots • Transactions    │   │
│  └───────────────────────────┬──────────────────────────────┘   │
│                              │                                   │
│  ┌───────────────────────────▼──────────────────────────────┐   │
│  │                    Persistent Storage                     │   │
│  │  /data (Volume Mount)                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
    Port 3000            Port 3001            Volume
    (HTTP API)          (WebSocket)          (/data)
```

## Dockerfile

**File**: `docker/Dockerfile`

```dockerfile
# Build stage
FROM oven/bun:1.1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Production stage
FROM oven/bun:1.1-slim

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 bri && \
    adduser --system --uid 1001 --gid 1001 bri

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/client ./client
COPY --from=builder /app/engine ./engine
COPY --from=builder /app/storage ./storage
COPY --from=builder /app/utils ./utils
COPY --from=builder /app/server ./server
COPY --from=builder /app/index.js ./

# Create data directory
RUN mkdir -p /data && chown -R bri:bri /data

# Environment
ENV NODE_ENV=production
ENV BRI_DATA_DIR=/data
ENV BRI_PORT=3000
ENV BRI_WS_PORT=3001
ENV BRI_MAX_MEMORY_MB=256

# Expose ports
EXPOSE 3000 3001

# Volume for persistent data
VOLUME ["/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Switch to non-root user
USER bri

# Start server
CMD ["bun", "run", "server/index.js"]
```

## Docker Compose

**File**: `docker/docker-compose.yml`

```yaml
version: '3.8'

services:
  bri:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    container_name: bri-server
    restart: unless-stopped

    ports:
      - "3000:3000"   # HTTP API
      - "3001:3001"   # WebSocket

    volumes:
      - bri-data:/data
      - ./config:/app/config:ro

    environment:
      - BRI_PORT=3000
      - BRI_WS_PORT=3001
      - BRI_MAX_MEMORY_MB=512
      - BRI_LOG_LEVEL=info
      - BRI_AUTH_ENABLED=true
      - BRI_AUTH_SECRET=${BRI_AUTH_SECRET}

    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '2'
        reservations:
          memory: 256M
          cpus: '0.5'

    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  bri-data:
    driver: local
```

## Server Implementation

**File**: `server/index.js`

```javascript
import { createDB } from '../client/index.js';
import { createServer } from './api.js';
import { createWebSocketServer } from './websocket.js';

const config = {
  port: parseInt(process.env.BRI_PORT) || 3000,
  wsPort: parseInt(process.env.BRI_WS_PORT) || 3001,
  dataDir: process.env.BRI_DATA_DIR || './data',
  maxMemoryMB: parseInt(process.env.BRI_MAX_MEMORY_MB) || 256,
  logLevel: process.env.BRI_LOG_LEVEL || 'info',
  auth: {
    enabled: process.env.BRI_AUTH_ENABLED === 'true',
    secret: process.env.BRI_AUTH_SECRET
  }
};

async function main() {
  console.log('BRI Server starting...');
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Memory limit: ${config.maxMemoryMB}MB`);

  // Initialize database
  const db = await createDB({
    storeConfig: {
      dataDir: config.dataDir,
      maxMemoryMB: config.maxMemoryMB
    }
  });

  console.log('BRI: Database initialized');

  // Create HTTP API server
  const httpServer = createServer(db, {
    auth: config.auth,
    logLevel: config.logLevel
  });

  // Create WebSocket server for subscriptions
  const wsServer = createWebSocketServer(db, {
    auth: config.auth
  });

  // Start servers
  httpServer.listen(config.port, () => {
    console.log(`BRI HTTP API listening on port ${config.port}`);
  });

  wsServer.listen(config.wsPort, () => {
    console.log(`BRI WebSocket server listening on port ${config.wsPort}`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    wsServer.close();
    httpServer.close();

    await db.disconnect();
    console.log('BRI: Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('BRI Server failed to start:', err);
  process.exit(1);
});
```

## API-Ape Integration

**File**: `server/api.js`

```javascript
import { Ape } from 'api-ape';  // v4

export function createServer(db, options = {}) {
  const app = new Ape();

  // Middleware
  if (options.auth?.enabled) {
    app.use(authMiddleware(options.auth));
  }

  app.use(corsMiddleware());
  app.use(rateLimitMiddleware());
  app.use(requestLogger(options.logLevel));

  // Health check
  app.get('/health', async (ctx) => {
    const stats = await db._store.stats();
    ctx.json({
      status: 'healthy',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      stats
    });
  });

  // ==================
  // CRUD Endpoints
  // ==================

  // Create entity
  // POST /api/:type
  app.post('/api/:type', async (ctx) => {
    const { type } = ctx.params;
    const data = await ctx.json();
    const opts = { saveBy: ctx.user?.$ID };

    try {
      const entity = await db.add[type](data, opts);
      ctx.status = 201;
      ctx.json(entity);
    } catch (error) {
      ctx.status = 400;
      ctx.json({ error: error.message });
    }
  });

  // Get single entity by ID
  // GET /api/:type/:id
  app.get('/api/:type/:id', async (ctx) => {
    const { type, id } = ctx.params;
    const populate = ctx.query.populate?.split(',');

    try {
      let entity = await db.get[type](id);

      if (!entity) {
        ctx.status = 404;
        ctx.json({ error: 'Not found' });
        return;
      }

      // Handle population
      if (populate?.length) {
        entity = await entity.populate(populate);
      }

      ctx.json(entity);
    } catch (error) {
      ctx.status = 500;
      ctx.json({ error: error.message });
    }
  });

  // Query entities
  // GET /api/:type
  // Query params: filter, sort, limit, offset, populate
  app.get('/api/:type', async (ctx) => {
    const { type } = ctx.params;
    const { filter, sort, limit, offset, populate } = ctx.query;

    try {
      // Use plural type for collection queries
      const pluralType = type + 'S';

      let entities;

      if (filter) {
        const filterObj = JSON.parse(filter);
        entities = await db.get[pluralType](filterObj);
      } else {
        entities = await db.get[pluralType]();
      }

      // Apply sorting
      if (sort) {
        const [field, order] = sort.split(':');
        entities.sort((a, b) => {
          const aVal = a[field];
          const bVal = b[field];
          return order === 'desc' ? bVal - aVal : aVal - bVal;
        });
      }

      // Apply pagination
      const start = parseInt(offset) || 0;
      const end = limit ? start + parseInt(limit) : undefined;
      entities = entities.slice(start, end);

      // Handle population
      if (populate) {
        const fields = populate.split(',');
        entities = await Promise.all(
          entities.map(e => e.populate(fields))
        );
      }

      ctx.json({
        data: entities,
        total: entities.length,
        offset: start,
        limit: parseInt(limit) || null
      });
    } catch (error) {
      ctx.status = 500;
      ctx.json({ error: error.message });
    }
  });

  // Update entity
  // PATCH /api/:type/:id
  app.patch('/api/:type/:id', async (ctx) => {
    const { type, id } = ctx.params;
    const updates = await ctx.json();

    try {
      const entity = await db.get[type](id);

      if (!entity) {
        ctx.status = 404;
        ctx.json({ error: 'Not found' });
        return;
      }

      // Apply updates
      Object.assign(entity, updates);
      await entity.save(ctx.user?.$ID);

      ctx.json(entity);
    } catch (error) {
      ctx.status = 400;
      ctx.json({ error: error.message });
    }
  });

  // Replace entity
  // PUT /api/:type/:id
  app.put('/api/:type/:id', async (ctx) => {
    const { type, id } = ctx.params;
    const data = await ctx.json();

    try {
      data.$ID = id;
      const entity = await db.set[type](data);
      ctx.json(entity);
    } catch (error) {
      ctx.status = 400;
      ctx.json({ error: error.message });
    }
  });

  // Delete entity
  // DELETE /api/:type/:id
  app.delete('/api/:type/:id', async (ctx) => {
    const { type, id } = ctx.params;

    try {
      await db.del[type](id, ctx.user?.$ID || 'API');
      ctx.status = 204;
    } catch (error) {
      ctx.status = 400;
      ctx.json({ error: error.message });
    }
  });

  // ==================
  // Transaction Endpoints
  // ==================

  // Start transaction
  // POST /api/_transaction
  app.post('/api/_transaction', async (ctx) => {
    const txnId = db.rec();
    ctx.json({ txnId });
  });

  // Commit transaction
  // POST /api/_transaction/:txnId/commit
  app.post('/api/_transaction/:txnId/commit', async (ctx) => {
    const { txnId } = ctx.params;

    try {
      await db.fin(txnId);
      ctx.json({ success: true });
    } catch (error) {
      ctx.status = 400;
      ctx.json({ error: error.message });
    }
  });

  // Rollback transaction
  // POST /api/_transaction/:txnId/rollback
  app.post('/api/_transaction/:txnId/rollback', async (ctx) => {
    const { txnId } = ctx.params;

    try {
      await db.nop(txnId);
      ctx.json({ success: true });
    } catch (error) {
      ctx.status = 400;
      ctx.json({ error: error.message });
    }
  });

  // ==================
  // Admin Endpoints
  // ==================

  // Database stats
  // GET /api/_admin/stats
  app.get('/api/_admin/stats', adminOnly, async (ctx) => {
    const stats = await db._store.stats();
    ctx.json(stats);
  });

  // Create snapshot
  // POST /api/_admin/snapshot
  app.post('/api/_admin/snapshot', adminOnly, async (ctx) => {
    await db._store.createSnapshot();
    ctx.json({ success: true });
  });

  // Archive
  // POST /api/_admin/archive
  app.post('/api/_admin/archive', adminOnly, async (ctx) => {
    const result = await db.archive.create();
    ctx.json(result);
  });

  // List archives
  // GET /api/_admin/archives
  app.get('/api/_admin/archives', adminOnly, async (ctx) => {
    const archives = await db.archive.list();
    ctx.json(archives);
  });

  return app;
}
```

## WebSocket Server

**File**: `server/websocket.js`

```javascript
export function createWebSocketServer(db, options = {}) {
  const subscriptions = new Map();  // ws -> Set of unsubscribe functions

  const server = Bun.serve({
    port: 0,  // Will be set later
    websocket: {
      open(ws) {
        subscriptions.set(ws, new Set());
        console.log('WebSocket client connected');
      },

      message(ws, message) {
        try {
          const msg = JSON.parse(message);
          handleMessage(ws, msg);
        } catch (error) {
          ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      },

      close(ws) {
        // Unsubscribe all
        const subs = subscriptions.get(ws);
        if (subs) {
          for (const unsub of subs) {
            unsub();
          }
        }
        subscriptions.delete(ws);
        console.log('WebSocket client disconnected');
      }
    }
  });

  async function handleMessage(ws, msg) {
    switch (msg.action) {
      case 'subscribe': {
        // Subscribe to entity type changes
        const { type, filter } = msg;
        const unsub = await db.sub[type]((change) => {
          // Apply filter if provided
          if (filter && !matchesFilter(change, filter)) {
            return;
          }

          ws.send(JSON.stringify({
            type: 'change',
            entityType: type,
            ...change
          }));
        });

        subscriptions.get(ws).add(unsub);

        ws.send(JSON.stringify({
          type: 'subscribed',
          entityType: type,
          subscriptionId: msg.id
        }));
        break;
      }

      case 'unsubscribe': {
        // TODO: Track subscription IDs for targeted unsubscribe
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  }

  function matchesFilter(change, filter) {
    // Simple filter matching
    for (const [key, value] of Object.entries(filter)) {
      if (change.target?.[key] !== value) {
        return false;
      }
    }
    return true;
  }

  return {
    listen(port) {
      server.port = port;
      server.reload({ port });
    },
    close() {
      server.stop();
    }
  };
}
```

## Authentication Middleware

**File**: `server/middleware/auth.js`

```javascript
import { verify } from 'jsonwebtoken';

export function authMiddleware(config) {
  return async (ctx, next) => {
    // Skip auth for health check
    if (ctx.path === '/health') {
      return next();
    }

    const authHeader = ctx.headers.get('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      ctx.status = 401;
      ctx.json({ error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = verify(token, config.secret);
      ctx.user = payload;
      return next();
    } catch (error) {
      ctx.status = 401;
      ctx.json({ error: 'Invalid token' });
    }
  };
}

export function adminOnly(ctx, next) {
  if (!ctx.user?.admin) {
    ctx.status = 403;
    ctx.json({ error: 'Admin access required' });
    return;
  }
  return next();
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BRI_PORT` | HTTP API port | 3000 |
| `BRI_WS_PORT` | WebSocket port | 3001 |
| `BRI_DATA_DIR` | Data directory | /data |
| `BRI_MAX_MEMORY_MB` | Memory limit | 256 |
| `BRI_LOG_LEVEL` | Log level (debug/info/warn/error) | info |
| `BRI_AUTH_ENABLED` | Enable JWT auth | false |
| `BRI_AUTH_SECRET` | JWT secret | - |
| `BRI_CORS_ORIGINS` | Allowed CORS origins | * |
| `BRI_RATE_LIMIT` | Requests per minute | 1000 |

## Kubernetes Deployment

**File**: `docker/k8s/deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bri-server
  labels:
    app: bri
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bri
  template:
    metadata:
      labels:
        app: bri
    spec:
      containers:
        - name: bri
          image: bri:latest
          ports:
            - containerPort: 3000
              name: http
            - containerPort: 3001
              name: websocket
          env:
            - name: BRI_MAX_MEMORY_MB
              value: "512"
            - name: BRI_AUTH_ENABLED
              value: "true"
            - name: BRI_AUTH_SECRET
              valueFrom:
                secretKeyRef:
                  name: bri-secrets
                  key: auth-secret
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            limits:
              memory: "1Gi"
              cpu: "2"
            requests:
              memory: "256Mi"
              cpu: "250m"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: bri-data-pvc

---
apiVersion: v1
kind: Service
metadata:
  name: bri-service
spec:
  selector:
    app: bri
  ports:
    - name: http
      port: 3000
      targetPort: 3000
    - name: websocket
      port: 3001
      targetPort: 3001
  type: ClusterIP

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: bri-data-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

## API Documentation

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /api/:type | Create entity |
| GET | /api/:type | List entities |
| GET | /api/:type/:id | Get entity by ID |
| PATCH | /api/:type/:id | Update entity |
| PUT | /api/:type/:id | Replace entity |
| DELETE | /api/:type/:id | Delete entity |
| POST | /api/_transaction | Start transaction |
| POST | /api/_transaction/:id/commit | Commit transaction |
| POST | /api/_transaction/:id/rollback | Rollback transaction |
| GET | /api/_admin/stats | Database stats |
| POST | /api/_admin/snapshot | Create snapshot |
| POST | /api/_admin/archive | Create archive |
| GET | /api/_admin/archives | List archives |

### WebSocket Protocol

**Subscribe to changes:**
```json
{
  "action": "subscribe",
  "type": "user",
  "filter": { "status": "active" }
}
```

**Change notification:**
```json
{
  "type": "change",
  "entityType": "user",
  "action": "UPDATE",
  "target": "USER_abc123",
  "patchs": [...]
}
```

## Files to Create

| File | Description |
|------|-------------|
| `docker/Dockerfile` | Container image definition |
| `docker/docker-compose.yml` | Compose configuration |
| `docker/k8s/deployment.yaml` | Kubernetes manifests |
| `server/index.js` | Server entry point |
| `server/api.js` | HTTP API routes |
| `server/websocket.js` | WebSocket server |
| `server/middleware/auth.js` | Authentication |
| `server/middleware/cors.js` | CORS handling |
| `server/middleware/rate-limit.js` | Rate limiting |
| `server/middleware/logger.js` | Request logging |

## Dependencies

| Package | Purpose |
|---------|---------|
| `api-ape` | HTTP framework |
| `jsonwebtoken` | JWT authentication |
