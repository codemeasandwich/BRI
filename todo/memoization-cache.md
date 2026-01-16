# Memoization Cache: Serialization Caching

## Overview

A caching layer that stores serialized output using a composite key of `$ID + updatedAt`, avoiding re-serialization for unchanged objects. This provides automatic cache invalidation when objects are modified.

## Current State

BRI currently:
- Has a stub at [engine/operations.js:89](../engine/operations.js#L89) that throws "not yet implemented"
- Re-serializes objects on every request
- Has no caching layer for JSS output
- Regenerates Diff patches every time

## Use Cases

1. **API Response Caching**: Cache serialized JSON responses for unchanged entities
2. **Patch Generation**: Cache computed patches between versions
3. **Subscription Broadcasting**: Cache serialized payloads sent to multiple subscribers
4. **Batch Exports**: Cache serialized output during bulk operations

## Proposed Architecture

### 1. Cache Strategy

**Key**: `$ID + obj.updatedAt` composite key
**Value**: Serialized JSS string

### 2. Cache Flow

```
Request comes in for $ID
         │
         ▼
┌─────────────────────────┐
│ 1. Fetch object from    │
│    hot/cold tier        │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. Check if cache key   │
│    $ID + obj.updatedAt  │
│    exists               │
└───────────┬─────────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
┌─────────┐   ┌─────────────────┐
│ CACHED  │   │ NOT CACHED      │
│ Return  │   │ Generate output │
│ stored  │   │ Store in cache  │
│ JSS     │   │ Return output   │
└─────────┘   └─────────────────┘
```

### 3. Benefits

- **Avoid re-serialization** for unchanged objects
- **Automatic invalidation** via `updatedAt` change
- **Memory efficient** - LRU eviction for cache entries
- **No stale data** - key includes timestamp

---

## Implementation

### 1. Memoization Cache Class

**File**: `engine/memoization/cache.js`

```javascript
import LRU from 'lru-cache';

export class MemoizationCache {
  constructor(options = {}) {
    this.cache = new LRU({
      max: options.maxEntries || 10000,
      maxSize: options.maxSizeMB ? options.maxSizeMB * 1024 * 1024 : 50 * 1024 * 1024,
      sizeCalculation: (value) => value.length,
      ttl: options.ttlMs || 0,  // 0 = no TTL, rely on key invalidation
      updateAgeOnGet: true
    });

    this.hits = 0;
    this.misses = 0;
  }

  // Generate cache key from entity
  getKey(entity, options = {}) {
    const baseKey = `${entity.$ID}:${entity.updatedAt?.getTime() || 0}`;

    // Include options in key for different serialization formats
    if (options.format) {
      return `${baseKey}:${options.format}`;
    }
    if (options.fields) {
      return `${baseKey}:${options.fields.sort().join(',')}`;
    }

    return baseKey;
  }

  // Get cached value or compute and store
  async getOrCompute(entity, computeFn, options = {}) {
    const key = this.getKey(entity, options);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    this.misses++;
    const value = await computeFn(entity);
    this.cache.set(key, value);
    return value;
  }

  // Get cached value only (no compute)
  get(entity, options = {}) {
    const key = this.getKey(entity, options);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.hits++;
    } else {
      this.misses++;
    }
    return cached;
  }

  // Set cache value
  set(entity, value, options = {}) {
    const key = this.getKey(entity, options);
    this.cache.set(key, value);
  }

  // Invalidate all entries for an entity (any updatedAt)
  invalidate(entityId) {
    // Since keys include updatedAt, old entries become unreachable
    // But we can proactively clear if needed
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${entityId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  // Clear entire cache
  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  // Get cache statistics
  stats() {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      calculatedSize: this.cache.calculatedSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits / (this.hits + this.misses) || 0
    };
  }
}
```

### 2. JSS Serialization Caching

**File**: `engine/memoization/jss-cache.js`

```javascript
import { MemoizationCache } from './cache.js';
import { serialize } from '../jss/serialize.js';

export class JSSCache {
  constructor(options = {}) {
    this.cache = new MemoizationCache({
      maxEntries: options.maxEntries || 5000,
      maxSizeMB: options.maxSizeMB || 25
    });
  }

  // Get or compute JSS serialization
  async serialize(entity, options = {}) {
    return this.cache.getOrCompute(
      entity,
      (e) => serialize(e, options),
      { format: 'jss', ...options }
    );
  }

  // Get or compute JSON serialization
  async toJSON(entity, options = {}) {
    return this.cache.getOrCompute(
      entity,
      (e) => JSON.stringify(e, options.replacer, options.space),
      { format: 'json', ...options }
    );
  }

  // Get or compute partial serialization (specific fields)
  async serializeFields(entity, fields) {
    return this.cache.getOrCompute(
      entity,
      (e) => {
        const partial = {};
        for (const field of fields) {
          if (field in e) {
            partial[field] = e[field];
          }
        }
        return serialize(partial);
      },
      { fields }
    );
  }

  stats() {
    return this.cache.stats();
  }
}
```

### 3. Patch Generation Caching

**File**: `engine/memoization/patch-cache.js`

```javascript
import { MemoizationCache } from './cache.js';
import { generatePatch } from '../utils/diff';

export class PatchCache {
  constructor(options = {}) {
    this.cache = new MemoizationCache({
      maxEntries: options.maxEntries || 2000,
      maxSizeMB: options.maxSizeMB || 10
    });
  }

  // Generate cache key for patch between two versions
  getPatchKey(entityId, fromVersion, toVersion) {
    return `patch:${entityId}:${fromVersion}:${toVersion}`;
  }

  // Get or compute patch between versions
  async getPatch(entity, previousState, currentState) {
    const fromVersion = previousState.updatedAt?.getTime() || 0;
    const toVersion = currentState.updatedAt?.getTime() || Date.now();

    const key = this.getPatchKey(entity.$ID, fromVersion, toVersion);

    const cached = this.cache.cache.get(key);
    if (cached) {
      this.cache.hits++;
      return cached;
    }

    this.cache.misses++;
    const patch = generatePatch(previousState, currentState);
    this.cache.cache.set(key, patch);
    return patch;
  }

  stats() {
    return this.cache.stats();
  }
}
```

### 4. Integration with Operations

**File**: `engine/operations.js` (modification at line 89)

```javascript
export function createOperations(store, deps) {
  const { memoCache, patchCache } = deps;

  return {
    // ... existing operations

    // Memoized get operation
    get: async (type, id, opts = {}) => {
      const entity = await store.get(`${type}_${id}`);
      if (!entity) return null;

      // Use memoization for serialization if enabled
      if (opts.serialize && memoCache) {
        return memoCache.serialize(entity, opts);
      }

      return entity;
    },

    // Memoized batch get
    getMany: async (type, ids, opts = {}) => {
      const entities = await Promise.all(
        ids.map(id => store.get(`${type}_${id}`))
      );

      if (opts.serialize && memoCache) {
        return Promise.all(
          entities.filter(Boolean).map(e => memoCache.serialize(e, opts))
        );
      }

      return entities.filter(Boolean);
    },

    // Update with patch caching
    update: async (entity, changes, opts = {}) => {
      const previousState = { ...entity };

      // Apply changes
      Object.assign(entity, changes);
      entity.updatedAt = new Date();

      await store.set(entity.$ID, entity);

      // Cache patch if enabled
      if (patchCache) {
        await patchCache.getPatch(entity, previousState, entity);
      }

      // Invalidate old serialization cache
      if (memoCache) {
        memoCache.cache.invalidate(entity.$ID);
      }

      return entity;
    }
  };
}
```

### 5. Subscription Broadcasting Optimization

```javascript
export class SubscriptionBroadcaster {
  constructor(memoCache) {
    this.memoCache = memoCache;
  }

  // Broadcast change to multiple subscribers efficiently
  async broadcast(entity, subscribers, changeType) {
    // Serialize once, send to all
    const serialized = await this.memoCache.serialize(entity);

    const payload = JSON.stringify({
      type: changeType,
      target: entity.$ID,
      data: serialized
    });

    // Send same payload to all subscribers
    for (const subscriber of subscribers) {
      subscriber.send(payload);
    }
  }
}
```

---

## Configuration

```javascript
const db = await createDB({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 },

  memoization: {
    enabled: true,

    jss: {
      maxEntries: 5000,
      maxSizeMB: 25
    },

    patch: {
      maxEntries: 2000,
      maxSizeMB: 10
    },

    // Auto-warm cache on startup
    warmOnStartup: false,

    // Log cache stats periodically
    statsIntervalMs: 60000
  }
});
```

---

## API

```javascript
// Get cache statistics
const stats = db.cache.stats();
// { jss: { hits: 1000, misses: 50, hitRate: 0.95 }, patch: { ... } }

// Manually invalidate cache for entity
db.cache.invalidate('USER_abc123');

// Clear all caches
db.cache.clear();

// Warm cache with frequently accessed entities
await db.cache.warm(['USER_abc', 'USER_def', 'POST_xyz']);

// Get serialized entity (uses cache)
const serialized = await db.get.user(id, { serialize: true });
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `engine/memoization/cache.js` | Create | Base memoization cache |
| `engine/memoization/jss-cache.js` | Create | JSS serialization cache |
| `engine/memoization/patch-cache.js` | Create | Patch generation cache |
| `engine/memoization/index.js` | Create | Module exports |
| `engine/operations.js` | Modify | Replace stub at line 89 |
| `client/index.js` | Modify | Initialize memoization |
| `client/proxy.js` | Modify | Add db.cache namespace |

## Dependencies

| Package | Purpose |
|---------|---------|
| `lru-cache` | LRU eviction (already used in hot-tier) |

## Priority

**MEDIUM** - Performance optimization that builds on existing functionality. Should be implemented after core features but before production deployment.
