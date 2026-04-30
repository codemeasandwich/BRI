# Hot Tier

In-memory LRU cache with frequency-weighted eviction.

## Overview

The hot tier provides fast in-memory access to frequently used documents. When memory usage exceeds the threshold, entries are evicted to cold storage based on access patterns.

## Features

- LRU cache with configurable memory limits
- Frequency-weighted eviction scoring
- Cold reference placeholders for evicted entries
- Automatic promotion from cold on access
- Dirty tracking for persistence
- Set operations for collections

## Usage

```javascript
import { HotTierCache } from './hot-tier/cache.js';

const cache = new HotTierCache({
  maxMemoryMB: 100,
  evictionThreshold: 0.8,
  onEvict: (key, value) => coldTier.write(key, value),
  coldLoader: (key) => coldTier.read(key)
});

await cache.set('doc_123', serializedData);
const data = await cache.get('doc_123');
```

## Eviction Strategy

Score = lastAccess * log(accessCount + 1)
- Lower scores evicted first
- Dirty entries skipped until persisted
- Target: 80% of threshold after eviction
