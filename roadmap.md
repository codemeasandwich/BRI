# BRI Database Roadmap

> A JavaScript-powered database layer with graph relationships, transactions, and smart caching.

---

## Table of Contents
1. [Vision](#vision)
2. [Smart Query Optimization](#smart-query-optimization)
3. [Memoization & Caching](#memoization--caching)
4. [Transaction System](#transaction-system-prepdumppush)
5. [Graph Relationships](#graph-relationships)
6. [Query Language](#query-language)
7. [Data Model](#data-model)
8. [Current Implementation Status](#current-implementation-status)

---

## Vision

**Core idea:** A database using JavaScript as its query engine.

**Future possibility:** Replace Redis with a pure Node/Bun process for the same functionality.
```bash
# Bun installation for future consideration
curl -fsSL https://bun.sh/install | bash
```

**Key principles:**
- Objects and Arrays as first-class citizens
- Easy leaf node replacement/movement
- Reference-aware for building graph networks (nodes & edges)
- Serialization via JSS or RFC6902 patches

---

## Smart Query Optimization

### Field Selection from Callback Parsing
Analyze the `.then()` callback source to determine which fields the caller actually needs:

```javascript
// Full object requested - fetch all fields
.then(objDB => { ... })

// Destructured - only fetch 'name' and 'address'
.then(({ name, address }) => { ... })
```

### Filter Function Optimization
Move filter logic from client-side to DB-side when possible:

```javascript
// Client-side filter (current)
.get.userS(({ age }) => retirement < age)

// DB-side filter with injected dependencies
.get.userS(({ age }, retirement) => retirement < age, retirement)

// DB-side filter with literal value
.get.userS(({ age }) => 64 < age)
```

**Pattern:** Pass filter function + N dependencies to enable server-side execution.

---

## Memoization & Caching

### Strategy
Cache serialized output using composite key: `$ID + updatedAt`

### Flow
1. Request comes in for `$ID`
2. Check if `$ID + obj.updatedAt` exists in cache
3. **If cached:** Return stored JSS immediately
4. **If not cached:** Generate output, store under key, return

### Benefits
- Avoid re-serialization for unchanged objects
- Invalidation is automatic via `updatedAt` change

---

## Transaction System (PREP/DUMP/PUSH)

A rollback system with configurable timeouts for atomic operations.

### Keywords
| Keyword | Purpose |
|---------|---------|
| `PREP` | Start transaction, stash all changes |
| `DUMP` | Rollback - discard changes, run cleanup |
| `PUSH` | Commit all stashed changes to DB |
| `MORE` | Reset timeout timer (request more time) |

### Default Timeout
1000ms - all operations within a transaction must complete within this window.

### Usage Patterns

#### Pattern 1: Wrapped Transaction
```javascript
db.PREP(() => {
  return Promise.all([
    db.add.user({ ... }),
    db.add.userbio({ ... })
  ])
}).then(([userDB, bioDB]) => {
  userDB.bio = bioDB;
  bioDB.user = userDB;
  return Promise.all([userDB.save(), bioDB.save()])
}).PUSH(([userDB, bioDB]) => {
  // Everything is now saved to DB
})
```

#### Pattern 2: Chained Transaction
```javascript
db.PREP.add.user({ ... })
  .then(userDB => {
    // Work with userDB
  })
  .then(() => {
    // More operations
  })
  .MORE(() => {
    // Timer reset - another 1000ms from now
    // This .then() + its returned Promise must complete in current window
  })
  .PUSH(() => {
    // Commit - everything saved to DB
  })
  .then(() => { })
  .catch(() => { })
  .finally(() => {
    // When finally returns, all changes are persisted
  })
```

#### Pattern 3: Conditional Rollback
```javascript
db.PREP.add.user({ ... })
  .then(userDB => {
    if (somethingWrong) {
      // Rollback: cleanup runs, jumps to finally, nothing saved
      return db.DUMP(cleanupFunction)
      // OR just: return db.DUMP
    }
    return userDB
  })
  .then(() => { })
  .catch(() => { })
  .finally(() => {
    // Reached whether PUSH or DUMP
  })
```

### Important Notes
- Do long-running operations (API calls) **before** starting `PREP`
- `MORE()` resets the timer but current `.then()` + its Promise must still complete in time
- `DUMP` can accept an optional cleanup function
- `DUMP` skips to `finally` without saving anything

---

## Graph Relationships

### Relationship Types

| Type | Direction | Example | Result |
|------|-----------|---------|--------|
| `LINK` | Bidirectional | `alice.LINK.friends(bob)` | `alice.friends.push(bob.$ID)` AND `bob.friends.push(alice.$ID)` |
| `REFS` | One-way | `alice.REFS.watchedS(matrix)` | `alice.watched.push(matrix.$ID)` only |

### Naming Convention for Cardinality
| Suffix | Meaning | Property Name |
|--------|---------|---------------|
| `S` (capital) | Array/multi, hidden from name | `childrenS` → property `children` (array) |
| `s` (lowercase) | Array/multi, visible in name | `friends` → property `friends` (array) |
| No suffix | Single reference | `bio` → property `bio` (single $ID) |

### API Examples

```javascript
var [alice, bob, carol] = getStore(["USER_irgib", "USER_n8934", "USER_lsd55"])
var [matrix, bluey] = getStore(["VIDS_latio", "VIDS_inePr"])

// Bidirectional friendship
alice.LINK.friends(bob)
// Result: alice.friends = ["USER_n8934"], bob.friends = ["USER_irgib"]

// Bidirectional with custom reverse name
alice.LINK.bio(aliceBio, "user")
// Result: alice.bio = "BIO_xxx", aliceBio.user = "USER_irgib"

// One-way reference (alice watches matrix, matrix doesn't track watchers)
alice.REFS.watchedS(matrix)
// Result: alice.watched = ["VIDS_latio"]

// Bidirectional with metadata
alice.LINK.childrenS(carol, "parents")
  .meta({ adoptedOn: new Date("2007-04-05T14:30") })
// Result: alice.children = ["USER_lsd55"], carol.parents = ["USER_irgib"]
// Plus: relationship metadata stored

bob.LINK.siblings(carol)
// Result: bob.siblings = ["USER_lsd55"], carol.siblings = ["USER_n8934"]
```

### Graph Traversal

#### FIND - Path-based Search
Build a path through relationships, execute when target provided:

```javascript
// Find path: alice → friends → children → watched → (target: bluey)
alice.FIND.friends.children.watched(bluey)

// Returns: [matchingNodes, [metaDataPerHop]]
const [results, [siblingsMeta, friendsMeta]] = alice.FIND.friends.children.watched(bluey)

/* results = [
  { name: "ann", watched: ["VIDS_inePr", "VIDS_isadv"], $ID: "USER_sdfvu", parents: ["USER_irgib", "USER_n8934"] },
  { name: "jack", watched: ["VIDS_inePr"], $ID: "USER_svvsf", parents: ["USER_irgib", "USER_n8934"] }
] */

/* siblingsMeta = [
  { $ID: "USER_sdfvu" },
  { $ID: "USER_svvsf", adoptedOn: new Date("2007-04-05T14:30") }
] */
```

#### WALK - Shortest Path
Find the shortest path between two nodes:

```javascript
alice.WALK(bluey)
// Returns: [[nodesAtEachPoint], [metaDataForEachHop]]
```

### Validation Rules
- Cannot self-reference: `from.$ID === to.$ID` throws error
- REFS cannot have reverse name: `alice.REFS.watched(x, "watchers")` throws error
- Cardinality mismatch throws error (using `S` on single-ref field or vice versa)

---

## Query Language

### Filtering with Relationships

```javascript
// Find users who have children with adoptedOn before 2012
db.run.userS.children(adoptedOn => new Date("2012") > adoptedOn)

// Chain through relationships
db.run.userS.children2.friends.$user()
```

---

## Data Model

### Storage Structure
Each record stored as two-part array: `[baseData, relationships]`

```javascript
{
  "USER_irgib": [
    { name: "Alice" },  // Base data
    { friends: ["USER_n8934", "USER_lsd55"], children: ["USER_lsd55"], watched: ["VIDS_latio"] }  // Relationships
  ],
  "USER_n8934": [
    { name: "Bob" },
    { bff: "USER_n8934", friends: ["USER_irgib"] }
  ],
  "USER_lsd55": [
    { name: "Carol" },
    { bff: "USER_n8934", friends: ["USER_irgib"], mother: "USER_irgib", watched: ["VIDS_inePr"] }
  ],
  "VIDS_latio": [{ name: "Matrix" }, {}],
  "VIDS_inePr": [{ name: "bluey" }, {}],
  "VIDS_isadv": [{ name: "pops the dog" }, {}]
}
```

### Graph Index
Separate lookup table indexed by relationship type:

```javascript
graphLookup = {
  friends: {
    "USER_irgib": [...],
    "USER_n8934": [...]
  },
  children: {
    "USER_irgib": [...]
  },
  watched: {
    "USER_irgib": [...],
    "USER_lsd55": [...]
  }
}
```

---

## Current Implementation Status

### Implemented (index.js)
- [x] Redis connection with retry logic
- [x] CRUD operations (`add`, `get`, `set`, `del`)
- [x] Pub/sub change notifications
- [x] Proxy-based change tracking
- [x] Basic `.populate()` for relationships
- [x] JSS serialization
- [x] RFC6902 patch generation for changes

### Not Yet Implemented
- [ ] Transaction system (PREP/DUMP/PUSH)
- [ ] Graph relationships API (LINK/REFS)
- [ ] FIND traversal
- [ ] WALK shortest path
- [ ] Relationship metadata
- [ ] Smart query optimization (field detection)
- [ ] Memoization cache
- [ ] Filter function DB-side execution
- [ ] Two-part storage model (base + relationships)
- [ ] Graph index lookup table

---

## Implementation Priority Suggestion

1. **Transaction System** - Most impactful for data integrity
2. **Graph Relationships (LINK/REFS)** - Core differentiator
3. **Memoization Cache** - Quick performance win
4. **FIND/WALK Traversal** - Advanced querying
5. **Smart Query Optimization** - Nice-to-have optimization
