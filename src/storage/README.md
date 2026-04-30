# Storage

Multi-tier persistence layer for BRI database with durability and caching.

## Overview

The storage layer provides a three-tier architecture:
- **Hot Tier** - In-memory LRU cache for fast access
- **Cold Tier** - JSON file-based storage for overflow
- **WAL** - Write-ahead log for crash recovery

## Architecture

```
┌─────────────┐
│   Engine    │
└──────┬──────┘
       │
┌──────▼──────┐
│   Adapter   │ (InHouse)
└──────┬──────┘
       │
┌──────▼──────┬──────────┬──────────┐
│  Hot Tier   │ Cold Tier│   WAL    │
│  (Memory)   │ (Files)  │ (Append) │
└─────────────┴──────────┴──────────┘
```

## Configuration

```javascript
const config = {
  maxMemoryMB: 100,          // Required: Memory limit
  dataDir: './data',         // Data directory
  fsyncMode: 'batched',      // 'always' | 'batched' | 'none'
  snapshotIntervalMs: 1800000 // Snapshot interval (30 min)
};
```
