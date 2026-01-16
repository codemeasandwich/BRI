# BRI Database Roadmap

> A JavaScript-powered database layer with graph relationships, transactions, and smart caching.

---

## Quick Status Summary

*Last updated: 2026-01-16*

| Category | Status | Details |
|----------|--------|---------|
| **Redis Replacement** | COMPLETE | Zero Redis dependencies - fully file-based |
| **Core Storage** | COMPLETE | WAL + Hot/Cold tiers + Snapshots |
| **Encryption at Rest** | COMPLETE | AES-256-GCM for WAL, snapshots, cold tier |
| **Transactions** | COMPLETE | `rec/fin/nop/pop` fully working |
| **CRUD + Pub/Sub** | COMPLETE | Full API with change tracking |
| **Graph Relationships** | NOT STARTED | See [graph-relationships.md](graph-relationships.md) |
| **Memoization Cache** | PARTIAL | See [memoization-cache.md](memoization-cache.md) |
| **Query Optimization** | NOT STARTED | See [query-optimization.md](query-optimization.md) |
| **Archive & Restore** | DESIGNED | See [archive-and-restore.md](archive-and-restore.md) |
| **Bootstrap Data** | DESIGNED | See [bootstrap-data.md](bootstrap-data.md) |
| **Soft-Delete Archive** | DESIGNED | See [del-soft-delete-archive.md](del-soft-delete-archive.md) |
| **Remote Configuration** | DESIGNED | See [remote-configuration.md](remote-configuration.md) |
| **Docker Deployment** | DESIGNED | See [deployment.md](deployment.md) |
| **Enum Support** | DESIGNED | See [enum-support.md](enum-support.md) |
| **Scribbles Logging** | DESIGNED | Remote endpoint for microservices log integration |
| **CLI Admin Dashboard** | DESIGNED | See [cli-admin-dashboard.md](cli-admin-dashboard.md) |

### Architecture Decisions (from archived plan.md)

The following architectural choices were made and fully implemented:
- **Storage Architecture**: Hybrid Memory + WAL (was "Architecture 2" in plan.md)
- **Persistence Model**: Append-Only Log with Snapshots (was "Store 3" in plan.md)
- **Language**: JavaScript/TypeScript (not Rust/Go/WASM alternatives)
- **Pub/Sub**: Process-local EventEmitter (not distributed)

---

## Table of Contents
1. [Vision](#vision)
2. [Transaction System](#transaction-system)
3. [Planned Features](#planned-features)
4. [Current Implementation Status](#current-implementation-status)
5. [Implementation Priority](#implementation-priority)

---

## Vision

**Core idea:** A database using JavaScript as its query engine.

**ACHIEVED:** Redis has been fully replaced with an in-house persistent store using WAL + Hot/Cold tiering.

**Key principles:**
- Objects and Arrays as first-class citizens
- Easy leaf node replacement/movement
- Reference-aware for building graph networks (nodes & edges)
- Serialization via JSS or Diff patches

---

## Transaction System

> **Note:** Implementation uses `rec/fin/nop/pop` instead of the vision's `PREP/DUMP/PUSH/MORE` naming.

| API | Vision Name | Purpose |
|-----|-------------|---------|
| `rec()` | `PREP` | Start transaction, stash all changes |
| `fin()` | `PUSH` | Commit all stashed changes to DB |
| `nop()` | `DUMP` | Rollback - discard changes, run cleanup |
| `pop()` | - | Undo last action within transaction |

See [storage/transaction/](../storage/transaction/) for implementation details.

---

## Planned Features

Detailed specifications for unimplemented features are in separate task files:

### Core Features
- **[Graph Relationships](graph-relationships.md)** - LINK/REFS/FIND/WALK (Priority: HIGH)
- **[Memoization Cache](memoization-cache.md)** - Serialization caching (Priority: MEDIUM)
- **[Query Optimization](query-optimization.md)** - Field selection & DB-side filters (Priority: LOW)

### Infrastructure
- **[Archive & Restore](archive-and-restore.md)** - WAL archival with compression
- **[Bootstrap Data](bootstrap-data.md)** - Initial data seeding mechanism
- **[Soft-Delete Archive](del-soft-delete-archive.md)** - Enhanced deletion with restore
- **[Remote Configuration](remote-configuration.md)** - Centralized config management
- **[Docker Deployment](deployment.md)** - Container deployment with API-Ape
- **[Enum Support](enum-support.md)** - Type-safe constrained values
- **Scribbles Logging** - Remote endpoint for BRI to push string/object logs to microservices logging systems
- **[CLI Admin Dashboard](cli-admin-dashboard.md)** - Terminal-based monitoring UI (Priority: MEDIUM)

---

## Current Implementation Status

### ✅ Fully Implemented

#### Core Database (index.js, engine/*)
- [x] CRUD operations (`add`, `get`, `set`, `del`)
- [x] Pub/sub change notifications (EventEmitter-based)
- [x] Proxy-based change tracking
- [x] Basic `.populate()` for relationships
- [x] JSS serialization
- [x] /utils/Diff patch generation for changes

#### In-House Storage (storage/*) - **REDIS FULLY REPLACED**
> Redis has been completely removed. All storage is now file-based with in-memory caching.

- [x] Hot Tier - LRU in-memory cache with frequency weighting ([storage/hot-tier/](../storage/hot-tier/))
- [x] Cold Tier - Filesystem JSON storage for overflow ([storage/cold-tier/](../storage/cold-tier/))
- [x] Write-Ahead Log (WAL) with batching, fsync modes, and pointer chain integrity ([storage/wal/](../storage/wal/))
- [x] Periodic snapshots (30min default) for fast recovery ([storage/snapshot/](../storage/snapshot/))
- [x] Set operations (`sAdd`, `sMembers`, `sRem`) for collection indexing
- [x] Full crash recovery (snapshot + WAL replay)
- [x] Encryption at rest - AES-256-GCM with pluggable key providers ([crypto/](../crypto/), see [encryption-at-rest.md](encryption-at-rest.md))

#### Transaction System (storage/transaction/*)
> **Note:** Implementation uses `rec/fin/nop/pop` instead of the `PREP/DUMP/PUSH/MORE` naming in the Vision section above.

- [x] `rec()` - Start transaction (equivalent to `PREP`)
- [x] `fin()` - Commit transaction (equivalent to `PUSH`)
- [x] `nop()` - Rollback transaction (equivalent to `DUMP`)
- [x] `pop()` - Undo last action within transaction
- [x] WAL-based transaction durability
- [x] Transaction isolation (changes hidden until committed)
- [x] Auto-injection of `txnId` via middleware

#### Additional Features
- [x] Middleware/plugin system with `db.use()`
- [x] Before/after hooks for operations
- [x] Schema validation (types, required, enum, getters/setters)
- [x] TypeScript definitions ([index.d.ts](../index.d.ts) - 337 lines)
- [x] Comprehensive test suite (15+ test files, 1000+ test cases)

### ⏳ Partially Implemented
- [ ] Memoization cache - stub exists at [engine/operations.js:89](../engine/operations.js#L89), see [memoization-cache.md](memoization-cache.md)

### ❌ Not Yet Implemented

See the "Planned Features" section above for links to detailed task specifications.

---

## Implementation Priority

1. **[Graph Relationships](graph-relationships.md)** - Core differentiator (HIGH)
2. **[Memoization Cache](memoization-cache.md)** - Performance optimization (MEDIUM)
3. **[Archive & Restore](archive-and-restore.md)** - Production hardening (MEDIUM)
4. **[CLI Admin Dashboard](cli-admin-dashboard.md)** - Operations monitoring (MEDIUM)
5. **[Bootstrap Data](bootstrap-data.md)** - Deployment convenience (MEDIUM)
6. **[Enum Support](enum-support.md)** - Type safety (LOW)
7. **[Query Optimization](query-optimization.md)** - Nice-to-have (LOW)
