# Snapshot

Periodic full-state snapshots for fast recovery.

## Overview

The snapshot manager creates periodic snapshots of the entire database state. Snapshots enable fast recovery by loading a recent checkpoint instead of replaying the entire WAL.

## Format

Single file: `data/snapshot.jss`

```json
{
  "version": 1,
  "walLine": 12345,
  "timestamp": "2024-01-15T...",
  "documents": { ... },
  "collections": { ... }
}
```

## Recovery Flow

1. Load latest snapshot (if exists)
2. Restore documents and collections
3. Replay WAL entries after snapshot.walLine
4. Database ready

## Configuration

- `intervalMs` - Snapshot interval (default: 30 minutes)
