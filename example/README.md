# BRI Example Project

A fully working example demonstrating the BRI database framework with Bun.

This directory uses a **local package alias** `"bri": "file:.."` in [`package.json`](package.json) so `import … from 'bri'` resolves to the repository root. Consumption from npm should use the published name **`bri-db`** or `npm link bri-db` inside a separate project.

## Prerequisites

- [Bun](https://bun.sh/) installed on your system

## Quick Start

```bash
# Install dependencies
bun install

# Run the example
bun run start
```

## What This Example Demonstrates

1. **Database Initialization** - Creating a BRI instance with in-house storage
2. **Create** (`db.add.typename`) - Adding new documents
3. **Read** (`db.get.typename`) - Fetching by ID, query object, or filter function
4. **Update** (`.save()`) - Modifying documents with automatic change tracking
5. **Relationships** (`.and.fieldName`) - Populating foreign key references
6. **Subscriptions** (`db.sub.typename`) - Real-time change notifications
7. **Replace** (`db.set.typename`) - Full document replacement
8. **Delete** (`db.del.typename`) - Soft deletion of documents
9. **Graceful Shutdown** (`db.disconnect()`) - Clean disconnection

## API Quick Reference

```javascript
import bri from 'bri';

const db = bri.connect({
  storeConfig: { dataDir: './data', maxMemoryMB: 64 }
});

// Create
const user = await db.add.user({ name: 'Alice', email: 'alice@example.com' });
// user.$ID = "USER_abc1234"

// Read single
const fetched = await db.get.user(user.$ID);           // by ID
const found = await db.get.user({ email: '...' });     // by query

// Read multiple (note the 'S' suffix)
const all = await db.get.userS();                      // all users
const filtered = await db.get.userS(u => u.age > 18);  // with filter

// Update
fetched.name = 'Alice Smith';
await fetched.save();

// Relationships
const post = await db.add.post({ title: 'Hi', author: user.$ID });
const withAuthor = await post.and.author;  // populates author field (property access, not method)

// Subscribe
const unsub = await db.sub.user(change => {
  console.log(change.action, change.target);
});

// Replace
await db.set.user({ $ID: user.$ID, name: 'New Name', ...allFields });

// Delete
await db.del.user(user.$ID, 'deletedBy_ID');

// Shutdown
await db.disconnect();
```

## Data Storage

Documents are held in the hot tier; evicted documents are written under `./data/cold/{TYPE}/{id}.jss`. The write-ahead log (`./data/wal/`), transaction staging (`./data/txn/`), and periodic snapshots (`./data/snapshots/`) complete the durability story.

## Cleanup

```bash
# Remove all data
bun run clean
```
