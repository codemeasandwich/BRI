# BRI Remote Client

Exposes BRI's database operations via api-ape's WebSocket transport. Provides the **exact same API as native BRI**.

## Usage

```javascript
import { apiDB } from 'bri/remote';

const db = await apiDB('ws://localhost:3000');

// Same API as local BRI!
const user = await db.add.user({ name: 'Alice', age: 28 });
const post = await db.get.post(postId).and.author;
user.name = 'Bob';
await user.save();
```

## API Reference

### CRUD Operations

```javascript
// Create
const user = await db.add.user({ name: 'Alice' });
const user = await db.add.user({ name: 'Alice' }, { saveBy: admin.$ID, tag: 'import' });

// Read single
const user = await db.get.user(userId);
const user = await db.get.user({ $ID: userId });

// Read all
const users = await db.get.userS();

// Read filtered (object query)
const admins = await db.get.userS({ role: 'admin' });

// Read filtered (function - client-side)
const adults = await db.get.userS(u => u.age >= 18);

// Update (via entity proxy)
user.name = 'Updated';
await user.save();
await user.save({ saveBy: editor.$ID });

// Replace
await db.set.user({ $ID: userId, name: 'Replaced', age: 30 });

// Delete (soft)
await db.del.user(userId, deletedBy);
```

### Population

```javascript
// .and syntax (chained)
const book = await db.get.book(bookId);
const withAuthor = await book.and.author;
const withProfile = await withAuthor.author.and.profile;

// .populate() method
const book = await db.get.book(bookId).populate('author');
const article = await db.get.article(id).populate(['author', 'editor']);
const full = await db.get.article(id)
  .populate('author')
  .populate('category');
```

### Subscriptions

```javascript
const unsubscribe = await db.sub.user(change => {
  console.log(change.action, change.target);
});

// Later:
unsubscribe();
```

### Transactions

```javascript
const txnId = db.rec();
await db.add.order({ items: ['a', 'b'] });
await db.add.payment({ amount: 100 });
await db.fin();  // Commit

// Or rollback:
await db.nop();

// Undo last action:
await db.pop();

// Check status:
db.txnStatus();
```

### Entity Methods

```javascript
user.toObject()   // Plain JS object
user.toJSON()     // JSON-serializable
user.toJSS()      // Extended serialization (Date, etc.)
user.toString()   // Returns $ID
user.$ID          // Entity identifier
```

## Architecture

```
+---------------------------------------------+
|           Client (Browser/Node)              |
|  +---------------------------------------+  |
|  | apiDB(url) -> db                       |  |
|  |   db.add.user(data) -> RPC             |  |
|  |   db.get.user(id)   -> RPC             |  |
|  |   entity.save()     -> RPC             |  |
|  |   entity.and.field  -> RPC             |  |
|  +---------------------------------------+  |
|                    | WebSocket               |
+---------------------------------------------+
                     |
+---------------------------------------------+
|           Server (docker/server)             |
|   Receives: { type, payload, queryId }       |
|   Returns:  { queryId, result, error }       |
+---------------------------------------------+
```

## Files

- `index.js` - Entry point, exports `apiDB` and `createRemoteDB`
- `connection.js` - WebSocket wrapper with promise-based RPC
- `proxy.js` - CRUD operation proxy factory
- `entity.js` - Entity wrapper with change tracking

## Differences from Native BRI

| Feature | Native | Remote |
|---------|--------|--------|
| Function filters | Server-side | Client-side (fetches all, filters locally) |
| Response caching | N/A | None (each call is fresh) |
| Offline support | N/A | Requires connection |
