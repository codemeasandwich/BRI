# BRI + api-ape Docker Deployment TODO

## Goal
Create a plug-and-play Docker container running a Bun server that exposes BRI's database operations via api-ape's RPC interface. Clients use a wrapper library that provides the **exact same API as native BRI**, including `.and.author` chaining.

---

## Decisions

| Decision | Choice |
|----------|--------|
| Location | `/docker` folder in BRI repo |
| Population | Multiple RPC calls mimicking native BRI `.and` syntax |
| Auth | api-ape's built-in tier-based auth system |
| Scaling | Single instance (no clustering) |

---

## Developer Experience

### Native BRI (Local)
```javascript
import { createDB } from 'bri';
const db = await createDB();

const user = await db.add.user({ name: 'Alice' });
const post = await db.get.post(postId).and.author.and.comments;
user.name = 'Bob';
await user.save();
```

### Remote BRI via api-ape (Identical API!)
```javascript
import { createRemoteDB } from 'bri/remote';

const db = await createRemoteDB('ws://localhost:3000');

// SAME CODE WORKS!
const user = await db.add.user({ name: 'Alice' });
const post = await db.get.post(postId).and.author.and.comments;
user.name = 'Bob';
await user.save();
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Container                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Bun Server (api-ape)               │    │
│  │                                                  │    │
│  │  ┌──────────────────────────────────────────┐   │    │
│  │  │         BRI Database Instance            │   │    │
│  │  │  - In-memory LRU cache                   │   │    │
│  │  │  - WAL + Cold storage (/data volume)     │   │    │
│  │  │  - Optional AES-256-GCM encryption       │   │    │
│  │  └──────────────────────────────────────────┘   │    │
│  │                                                  │    │
│  │  api-ape RPC endpoints:                         │    │
│  │  - /db/get/:type/:query   → db.get operations  │    │
│  │  - /db/add/:type          → db.add operations  │    │
│  │  - /db/set/:type          → db.set operations  │    │
│  │  - /db/del/:type          → db.del operations  │    │
│  │  - /db/sub/:type          → subscriptions      │    │
│  │  - /db/populate           → .and.field calls   │    │
│  │  - /db/save               → entity.save()      │    │
│  │  - /db/txn/*              → transactions       │    │
│  └──────────────────────────────────────────────────┘   │
│                         ↕ WebSocket                      │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Checklist

### Phase 1: Docker Infrastructure
- [ ] Create `/docker/Dockerfile` - Bun base image with BRI + api-ape
- [ ] Create `/docker/docker-compose.yml` - Service definition with volume mounts
- [ ] Create `/docker/.env.example` - Environment variables template

### Phase 2: Server Implementation
- [ ] Create `/docker/server/package.json` - Dependencies (bri, api-ape)
- [ ] Create `/docker/server/index.js` - Bun entry point, initializes BRI and api-ape

### Phase 3: API Controllers
- [ ] `/docker/server/api/db/get.js` - Handle get operations → `db.get.type(query)`
- [ ] `/docker/server/api/db/add.js` - Handle create operations → `db.add.type(data)`
- [ ] `/docker/server/api/db/set.js` - Handle replace operations → `db.set.type(data)`
- [ ] `/docker/server/api/db/del.js` - Handle delete operations → `db.del.type(id)`
- [ ] `/docker/server/api/db/sub.js` - Handle subscriptions → `db.sub.type(callback)`
- [ ] `/docker/server/api/db/populate.js` - Handle `.and.field` calls
- [ ] `/docker/server/api/db/save.js` - Handle entity saves → `entity.save()`
- [ ] `/docker/server/api/db/txn/rec.js` - Start transaction → `db.rec()`
- [ ] `/docker/server/api/db/txn/fin.js` - Commit transaction → `db.fin()`
- [ ] `/docker/server/api/db/txn/nop.js` - Cancel transaction → `db.nop()`
- [ ] `/docker/server/api/db/txn/pop.js` - Undo last action → `db.pop()`

### Phase 4: Client Wrapper
- [ ] Create `/remote/index.js` - `createRemoteDB(url)` factory function
- [ ] Create `/remote/proxy.js` - Proxy handlers that mimic BRI's API
- [ ] Create `/remote/entity.js` - Remote entity wrapper with `.and`, `.save()`, `.toObject()`

### Phase 5: Documentation
- [ ] Create `/docker/README.md` - Setup and deployment instructions
- [ ] Update main README - Reference remote usage

---

## Files to Create

```
/docker/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── README.md
└── server/
    ├── package.json
    ├── index.js
    └── api/
        └── db/
            ├── get.js
            ├── add.js
            ├── set.js
            ├── del.js
            ├── sub.js
            ├── populate.js
            ├── save.js
            └── txn/
                ├── rec.js
                ├── fin.js
                ├── nop.js
                └── pop.js

/remote/
├── index.js
├── proxy.js
└── entity.js
```

---

## Key Implementation Details

### 1. Entity Tracking (Server-Side)
Each WebSocket connection maintains a map of "live" entities:
```javascript
// Per-connection state
connection.entities = new Map(); // entityId → { data, changes }
connection.activeTxnId = null;
```

### 2. `.and.field` Population Flow
```
Client: post.and.author
   ↓
RPC Call: /db/populate { entityId: 'POST_abc', field: 'author' }
   ↓
Server: Looks up entity, calls BRI's populate, returns new entity
   ↓
Client: Returns new proxy-wrapped entity
```

### 3. `.save()` Flow
```
Client: user.name = 'Bob'; await user.save()
   ↓
RPC Call: /db/save { entityId: 'USER_xyz', changes: { name: 'Bob' } }
   ↓
Server: Applies changes via BRI, returns updated entity
   ↓
Client: Returns new proxy-wrapped entity
```

### 4. Subscriptions via api-ape Events
```javascript
// Client
await db.sub.user((change) => console.log(change));

// Internally:
api.on('db:sub:user', ({ data }) => callback(data));

// Server broadcasts changes:
this.broadcast('db:sub:user', changeEvent);
```

### 5. Transactions per Connection
```javascript
// Each WebSocket connection can have ONE active transaction
connection.activeTxnId = await db.rec(); // Store txnId

// All operations from this connection use the txnId
await db.add.user(data, { txnId: connection.activeTxnId });
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `DATA_DIR` | /data | Persistent storage path |
| `MAX_MEMORY_MB` | 256 | LRU cache size |
| `ENCRYPTION_KEY` | (none) | Optional AES-256-GCM key |
| `AUTH_REQUIRED` | false | Require authentication |

---

## Verification Plan

1. **Build & Run**: `docker-compose up --build`
2. **Basic CRUD**: Test add/get/set/del operations
3. **Population**: Test `.and.field` chaining
4. **Subscriptions**: Verify real-time updates
5. **Transactions**: Test rec/fin/nop/pop flow
6. **Persistence**: Restart container, verify data survives
7. **Auth**: Test tier-based access control

---

## Example docker-compose.yml

```yaml
version: '3.8'
services:
  bri:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - bri-data:/data
    environment:
      - PORT=3000
      - DATA_DIR=/data
      - MAX_MEMORY_MB=256

volumes:
  bri-data:
```

---

## Example Client Usage

```javascript
import { createRemoteDB } from 'bri/remote';

// Connect to BRI server
const db = await createRemoteDB('ws://localhost:3000');

// Create a user
const user = await db.add.user({
  name: 'Alice',
  email: 'alice@example.com'
});
console.log(user.$ID); // USER_abc1234

// Query users
const admins = await db.get.userS({ role: 'admin' });

// Get with population
const post = await db.get.post(postId);
const withAuthor = await post.and.author;
console.log(withAuthor.author.name);

// Reactive updates
user.name = 'Alice Smith';
const updated = await user.save();

// Subscriptions
await db.sub.user((change) => {
  console.log('User changed:', change);
});

// Transactions
db.rec();
await db.add.order({ items: [...] });
await db.add.payment({ amount: 100 });
await db.fin(); // Commit both

// Disconnect
await db.disconnect();
```
