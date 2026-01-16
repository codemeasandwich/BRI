# Graph Relationships: LINK/REFS/FIND/WALK

## Overview

A graph relationship system that enables bidirectional and one-way relationships between entities, with traversal capabilities for finding paths and connections. This is BRI's core differentiator, enabling graph-like data modeling on top of the existing document store.

## Current State

BRI currently has:
- Basic `.populate()` for resolving single references
- No native relationship tracking
- No bidirectional linking
- No graph traversal capabilities
- Single-part storage model (no separation of base data vs relationships)

## Proposed Architecture

### 1. Relationship Types

| Type | Direction | Description |
|------|-----------|-------------|
| `LINK` | Bidirectional | Both entities reference each other |
| `REFS` | One-way | Only the source entity holds the reference |

### 2. Naming Convention for Cardinality

| Suffix | Meaning | Property Name |
|--------|---------|---------------|
| `S` (capital) | Array/multi, hidden from name | `childrenS` → property `children` (array) |
| `s` (lowercase) | Array/multi, visible in name | `friends` → property `friends` (array) |
| No suffix | Single reference | `bio` → property `bio` (single $ID) |

### 3. Two-Part Storage Model

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
  "VIDS_inePr": [{ name: "bluey" }, {}]
}
```

### 4. Graph Index Lookup Table

Separate lookup table indexed by relationship type for fast traversal:

```javascript
graphLookup = {
  friends: {
    "USER_irgib": ["USER_n8934", "USER_lsd55"],
    "USER_n8934": ["USER_irgib"]
  },
  children: {
    "USER_irgib": ["USER_lsd55"]
  },
  watched: {
    "USER_irgib": ["VIDS_latio"],
    "USER_lsd55": ["VIDS_inePr"]
  }
}
```

---

## API Design

### LINK - Bidirectional Relationships

```javascript
var [alice, bob, carol] = getStore(["USER_irgib", "USER_n8934", "USER_lsd55"])
var [matrix, bluey] = getStore(["VIDS_latio", "VIDS_inePr"])

// Bidirectional friendship
alice.LINK.friends(bob)
// Result: alice.friends = ["USER_n8934"], bob.friends = ["USER_irgib"]

// Bidirectional with custom reverse name
alice.LINK.bio(aliceBio, "user")
// Result: alice.bio = "BIO_xxx", aliceBio.user = "USER_irgib"

// Bidirectional with metadata
alice.LINK.childrenS(carol, "parents")
  .meta({ adoptedOn: new Date("2007-04-05T14:30") })
// Result: alice.children = ["USER_lsd55"], carol.parents = ["USER_irgib"]
// Plus: relationship metadata stored

bob.LINK.siblings(carol)
// Result: bob.siblings = ["USER_lsd55"], carol.siblings = ["USER_n8934"]
```

### REFS - One-Way References

```javascript
// One-way reference (alice watches matrix, matrix doesn't track watchers)
alice.REFS.watchedS(matrix)
// Result: alice.watched = ["VIDS_latio"]
```

### FIND - Path-Based Search

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

### WALK - Shortest Path

Find the shortest path between two nodes:

```javascript
alice.WALK(bluey)
// Returns: [[nodesAtEachPoint], [metaDataForEachHop]]
```

---

## Implementation Details

### 1. Relationship Manager

**File**: `engine/graph/manager.js`

```javascript
export class RelationshipManager {
  constructor(store) {
    this.store = store;
    this.graphIndex = new Map();  // relationshipType -> Map<$ID, Set<$ID>>
    this.metadata = new Map();    // `${from}:${rel}:${to}` -> metadata
  }

  // Create bidirectional link
  async link(from, relationName, to, reverseRelationName, metadata = null) {
    // Validate: cannot self-reference
    if (from.$ID === to.$ID) {
      throw new GraphError('Cannot create self-referential link');
    }

    // Determine cardinality from naming convention
    const isArray = this.isArrayRelation(relationName);
    const reverseIsArray = reverseRelationName ? this.isArrayRelation(reverseRelationName) : isArray;

    // Add forward reference
    await this.addReference(from, relationName, to.$ID, isArray);

    // Add reverse reference
    const reverseName = reverseRelationName || relationName;
    await this.addReference(to, reverseName, from.$ID, reverseIsArray);

    // Store metadata if provided
    if (metadata) {
      await this.setMetadata(from.$ID, relationName, to.$ID, metadata);
    }

    // Update graph index
    this.updateIndex(relationName, from.$ID, to.$ID);
    this.updateIndex(reverseName, to.$ID, from.$ID);
  }

  // Create one-way reference
  async refs(from, relationName, to, metadata = null) {
    const isArray = this.isArrayRelation(relationName);
    await this.addReference(from, relationName, to.$ID, isArray);

    if (metadata) {
      await this.setMetadata(from.$ID, relationName, to.$ID, metadata);
    }

    this.updateIndex(relationName, from.$ID, to.$ID);
  }

  // Check if relation name indicates array (ends with S or s)
  isArrayRelation(name) {
    return name.endsWith('S') || name.endsWith('s');
  }

  // Get property name from relation name (strip trailing S)
  getPropertyName(relationName) {
    if (relationName.endsWith('S')) {
      return relationName.slice(0, -1);
    }
    return relationName;
  }

  // Add reference to entity
  async addReference(entity, relationName, targetId, isArray) {
    const propName = this.getPropertyName(relationName);

    if (isArray) {
      if (!entity[propName]) {
        entity[propName] = [];
      }
      if (!entity[propName].includes(targetId)) {
        entity[propName].push(targetId);
      }
    } else {
      entity[propName] = targetId;
    }

    await entity.save();
  }

  // Remove relationship
  async unlink(from, relationName, to, reverseRelationName = null) {
    const propName = this.getPropertyName(relationName);
    const isArray = this.isArrayRelation(relationName);

    // Remove forward reference
    if (isArray) {
      const idx = from[propName]?.indexOf(to.$ID);
      if (idx > -1) from[propName].splice(idx, 1);
    } else {
      delete from[propName];
    }

    // Remove reverse reference for LINK
    if (reverseRelationName !== false) {
      const reverseName = reverseRelationName || relationName;
      const reverseProp = this.getPropertyName(reverseName);
      const reverseIsArray = this.isArrayRelation(reverseName);

      if (reverseIsArray) {
        const idx = to[reverseProp]?.indexOf(from.$ID);
        if (idx > -1) to[reverseProp].splice(idx, 1);
      } else {
        delete to[reverseProp];
      }

      await to.save();
    }

    await from.save();

    // Clear metadata
    this.clearMetadata(from.$ID, relationName, to.$ID);

    // Update graph index
    this.removeFromIndex(relationName, from.$ID, to.$ID);
  }
}
```

### 2. Graph Traversal

**File**: `engine/graph/traversal.js`

```javascript
export class GraphTraversal {
  constructor(relationshipManager) {
    this.rm = relationshipManager;
  }

  // FIND: Path-based search
  async find(startEntity, path, target = null) {
    const results = [];
    const metadataPerHop = [];

    let currentNodes = [startEntity];

    for (const relationName of path) {
      const nextNodes = [];
      const hopMetadata = [];

      for (const node of currentNodes) {
        const propName = this.rm.getPropertyName(relationName);
        const refs = Array.isArray(node[propName]) ? node[propName] : [node[propName]].filter(Boolean);

        for (const ref of refs) {
          const entity = await this.rm.store.get(ref);
          if (entity) {
            nextNodes.push(entity);
            const meta = await this.rm.getMetadata(node.$ID, relationName, ref);
            hopMetadata.push(meta || { $ID: ref });
          }
        }
      }

      currentNodes = nextNodes;
      metadataPerHop.push(hopMetadata);
    }

    // Filter by target if provided
    if (target) {
      const targetId = target.$ID || target;
      currentNodes = currentNodes.filter(node => {
        // Check if any of node's relationships point to target
        return Object.values(node).flat().includes(targetId);
      });
    }

    return [currentNodes, metadataPerHop];
  }

  // WALK: Shortest path using BFS
  async walk(startEntity, targetEntity, options = {}) {
    const startId = startEntity.$ID;
    const targetId = targetEntity.$ID;
    const maxDepth = options.maxDepth || 10;

    const visited = new Set([startId]);
    const queue = [[startEntity, [], []]];  // [node, path, metadata]

    while (queue.length > 0) {
      const [current, path, metadata] = queue.shift();

      if (path.length > maxDepth) continue;

      // Get all relationships for current node
      const relationships = await this.getAllRelationships(current);

      for (const { relationName, targetIds } of relationships) {
        for (const tid of targetIds) {
          if (tid === targetId) {
            // Found target
            const finalPath = [...path, current, targetEntity];
            const meta = await this.rm.getMetadata(current.$ID, relationName, tid);
            return [finalPath, [...metadata, meta || {}]];
          }

          if (!visited.has(tid)) {
            visited.add(tid);
            const entity = await this.rm.store.get(tid);
            if (entity) {
              const meta = await this.rm.getMetadata(current.$ID, relationName, tid);
              queue.push([
                entity,
                [...path, current],
                [...metadata, meta || {}]
              ]);
            }
          }
        }
      }
    }

    return [[], []];  // No path found
  }

  // Get all relationships from an entity
  async getAllRelationships(entity) {
    const relationships = [];

    for (const [key, value] of Object.entries(entity)) {
      if (key.startsWith('$') || key.startsWith('_')) continue;

      if (typeof value === 'string' && value.includes('_')) {
        // Potential single reference
        relationships.push({ relationName: key, targetIds: [value] });
      } else if (Array.isArray(value) && value.every(v => typeof v === 'string' && v.includes('_'))) {
        // Array of references
        relationships.push({ relationName: key, targetIds: value });
      }
    }

    return relationships;
  }
}
```

### 3. Proxy Integration

**File**: `client/proxy.js` (additions)

```javascript
// Add LINK/REFS/FIND/WALK to entity proxy
function createEntityProxy(entity, deps) {
  const { relationshipManager, graphTraversal } = deps;

  return new Proxy(entity, {
    get(target, prop) {
      if (prop === 'LINK') {
        return createLinkProxy(target, relationshipManager);
      }
      if (prop === 'REFS') {
        return createRefsProxy(target, relationshipManager);
      }
      if (prop === 'FIND') {
        return createFindProxy(target, graphTraversal);
      }
      if (prop === 'WALK') {
        return (targetEntity, options) => graphTraversal.walk(target, targetEntity, options);
      }
      return Reflect.get(target, prop);
    }
  });
}

function createLinkProxy(entity, rm) {
  return new Proxy({}, {
    get(_, relationName) {
      return (targetEntity, reverseRelationName = null) => {
        const linkPromise = rm.link(entity, relationName, targetEntity, reverseRelationName);
        linkPromise.meta = (metadata) => {
          return rm.setMetadata(entity.$ID, relationName, targetEntity.$ID, metadata);
        };
        return linkPromise;
      };
    }
  });
}

function createRefsProxy(entity, rm) {
  return new Proxy({}, {
    get(_, relationName) {
      return (targetEntity) => {
        return rm.refs(entity, relationName, targetEntity);
      };
    }
  });
}

function createFindProxy(entity, traversal, path = []) {
  return new Proxy(() => {}, {
    get(_, relationName) {
      return createFindProxy(entity, traversal, [...path, relationName]);
    },
    apply(_, __, [target]) {
      return traversal.find(entity, path, target);
    }
  });
}
```

---

## Validation Rules

| Rule | Description |
|------|-------------|
| No self-reference | `from.$ID === to.$ID` throws error |
| REFS no reverse | `alice.REFS.watched(x, "watchers")` throws error |
| Cardinality match | Using `S` on single-ref field or vice versa throws error |

---

## Query Language Integration

```javascript
// Find users who have children with adoptedOn before 2012
db.run.userS.children(adoptedOn => new Date("2012") > adoptedOn)

// Chain through relationships
db.run.userS.children2.friends.$user()
```

---

## WAL Integration

New WAL operation types for relationships:

```javascript
{
  action: 'LINK',
  from: 'USER_abc',
  to: 'USER_def',
  relation: 'friends',
  reverseRelation: 'friends',
  metadata: { since: '2024-01-15' }
}

{
  action: 'UNLINK',
  from: 'USER_abc',
  to: 'USER_def',
  relation: 'friends'
}
```

---

## Migration from Current System

For existing databases with manual references:

```javascript
// Detect and index existing relationships
await db.graph.index.rebuild();

// Convert manual references to managed relationships
await db.graph.migrate({
  types: {
    user: {
      friends: { type: 'LINK', reverse: 'friends' },
      bio: { type: 'LINK', reverse: 'user' }
    }
  }
});
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `engine/graph/manager.js` | Create | Relationship manager |
| `engine/graph/traversal.js` | Create | FIND/WALK implementation |
| `engine/graph/index.js` | Create | Graph index for fast lookups |
| `engine/graph/errors.js` | Create | Graph-specific errors |
| `client/proxy.js` | Modify | Add LINK/REFS/FIND/WALK proxies |
| `storage/wal/entry.js` | Modify | Add LINK/UNLINK operations |
| `storage/adapters/inhouse.js` | Modify | Initialize graph components |

## Dependencies

None - pure JavaScript implementation

## Configuration

```javascript
const db = await createDB({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 },

  graph: {
    enabled: true,
    indexInMemory: true,      // Keep graph index in memory
    validateOnWrite: true,    // Validate relationships on write
    cascadeDelete: false      // Auto-delete relationships when entity deleted
  }
});
```

## Priority

**HIGH** - This is the core differentiator for BRI and enables graph features that distinguish it from other document stores.
