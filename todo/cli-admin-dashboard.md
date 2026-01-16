# CLI Admin Dashboard

> Terminal-based monitoring UI for BRI database operations, inspired by [mongomonitor](https://github.com/codemeasandwich/mongomonitor).

**Priority:** MEDIUM
**Status:** DESIGNED

---

## Overview

A real-time terminal dashboard for monitoring BRI database internals. Provides visibility into storage tiers, transactions, WAL status, and live operations without requiring external tools.

---

## Features

### Real-time Activity Log
Stream of CRUD operations as they happen:
- Operation type (add/get/set/del)
- Key/collection affected
- Timestamp
- Transaction ID (if applicable)

### System Resources
- CPU utilization
- Memory usage (process + V8 heap)
- Event loop lag

### Hot/Cold Tier Statistics
- Hot tier: entries count, memory usage, hit rate, eviction count
- Cold tier: entries count, disk usage
- Promotion/demotion activity

### WAL Status
- Pending writes count
- Current sync mode (immediate/batched)
- Pointer chain health
- Last flush timestamp
- WAL file size

### Transaction Monitor
- Active transactions count
- Commit/rollback rates
- Average transaction duration
- Stalled transaction warnings

### Pub/Sub Activity
- Events per second
- Active subscriptions by collection
- Event type breakdown

### Snapshot Status
- Last snapshot timestamp
- Next scheduled snapshot
- Snapshot file size
- Recovery point objective (RPO)

### Server Info
- Uptime
- BRI version
- Configuration summary
- Data directory path

---

## UI Layout (Conceptual)

```
┌─────────────────────────────────────────────────────────────────┐
│ BRI Dashboard                              CPU: 12%  MEM: 256MB │
├─────────────────────────────────────────────────────────────────┤
│ HOT TIER          │ COLD TIER         │ WAL                     │
│ Entries: 1,234    │ Entries: 45,678   │ Pending: 3              │
│ Memory: 128MB     │ Disk: 1.2GB       │ Mode: batched           │
│ Hit Rate: 94.2%   │                   │ Last Flush: 2s ago      │
├─────────────────────────────────────────────────────────────────┤
│ TRANSACTIONS                │ SNAPSHOTS                         │
│ Active: 2                   │ Last: 15 min ago                  │
│ Commits/s: 45               │ Next: in 15 min                   │
│ Rollbacks/s: 1              │ Size: 89MB                        │
├─────────────────────────────────────────────────────────────────┤
│ ACTIVITY LOG                                                    │
│ 12:34:56 SET users:123 {name: "Alice"} [txn:abc]               │
│ 12:34:55 GET posts:456                                          │
│ 12:34:54 ADD comments:789 [txn:abc]                            │
│ 12:34:53 DEL sessions:old                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Notes

### Technology Options
- **blessed** / **blessed-contrib** - Full-featured terminal UI with widgets
- **ink** - React-based terminal rendering
- **cli-table3** + **ora** - Simpler table-based output with spinners

### Data Sources
Requires exposing internal metrics from:
- `storage/hot-tier/` - cache stats
- `storage/cold-tier/` - file counts
- `storage/wal/` - write queue, sync status
- `storage/transaction/` - active transactions
- `storage/snapshot/` - timing info
- `engine/` - pub/sub event counts

### Considerations
- Should work as standalone CLI tool or embedded in app
- Low overhead - polling interval configurable (default 1s)
- Non-blocking data collection
- Graceful degradation if certain metrics unavailable

---

## References
- [mongomonitor](https://github.com/codemeasandwich/mongomonitor) - Inspiration
- [blessed-contrib](https://github.com/yaronn/blessed-contrib) - Terminal dashboards
