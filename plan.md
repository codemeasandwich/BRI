# BRI Persistent Store Replacement Plan

## Overview

This document outlines the plan to replace Redis with an **in-house persistent store** that sits underneath the existing BRI database engine ([index.js](index.js)). The BRI engine API and logic will remain unchanged.

---

## Part 1: BRI Engine (Unchanged)

The BRI database engine ([index.js](index.js)) provides:

```
┌─────────────────────────────────────────────────────────────┐
│                    BRI Database Engine                      │
│                      (index.js - KEEP)                      │
├─────────────────────────────────────────────────────────────┤
│  Public API:                                                │
│    db.add.type(data)     → CREATE document                  │
│    db.get.type(query)    → READ document(s)                 │
│    db.set.type(object)   → UPDATE/REPLACE document          │
│    db.del.type(id)       → DELETE document (soft)           │
│    db.sub.type(callback) → SUBSCRIBE to changes             │
│    db.pin.type(data)     → CACHE (not yet implemented)      │
│                                                             │
│  Internal Features:                                         │
│    - Proxy-based change tracking                            │
│    - @diff package change tracking (tuple-based patches)    │
│    - Automatic $ID generation (TYPE_xxxxxxx)                │
│    - .save() method on retrieved objects                    │
│    - .and.property() for population                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Storage Interface (TO BE CREATED)              │
├─────────────────────────────────────────────────────────────┤
│  Required Operations:                                       │
│    set(key, value)           → Store JSON document          │
│    get(key)                  → Retrieve JSON document       │
│    rename(oldKey, newKey)    → Rename key (soft delete)     │
│    sAdd(set, member)         → Add to collection set        │
│    sMembers(set)             → Get all set members          │
│    sRem(set, member)         → Remove from collection set   │
│    publish(channel, message) → Broadcast change event       │
│    subscribe(channel, cb)    → Listen for change events     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│           In-House Persistent Store (TO BE BUILT)           │
│                  (Proposals below)                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 2: In-House Persistent Store Proposals

### Requirements for the Persistent Store

Based on current Redis usage in [index.js:158-181](index.js#L158-L181) and throughout:

| Requirement | Current Redis Usage | Priority |
|-------------|---------------------|----------|
| **Key-Value Storage** | `client.set($ID, JSON)` / `client.get($ID)` | P0 |
| **Set Operations** | `client.sAdd()` / `client.sMembers()` / `client.sRem()` | P0 |
| **Pub/Sub** | `client.publish()` / `subscriber.subscribe()` | P0 |
| **Key Rename** | `client.rename($ID, "X:"+$ID+":X")` | P1 |
| **Connection Resilience** | Auto-reconnect with backoff | P1 |
| **Async/Promise API** | All operations return Promises | P0 |

---

## Architecture Proposals

### Architecture 1: Single-File Embedded Store

**Description:** A single JavaScript/TypeScript module that embeds all storage logic using file-based persistence.

```
┌─────────────────────────────────────────────────┐
│              BRI Engine (index.js)              │
└───────────────────────┬─────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│         Embedded Store (single file)            │
├─────────────────────────────────────────────────┤
│  ┌───────────────┐  ┌───────────────┐          │
│  │  In-Memory    │  │  EventEmitter │          │
│  │  Map + Set    │  │  (Pub/Sub)    │          │
│  └───────┬───────┘  └───────────────┘          │
│          │                                      │
│          ▼                                      │
│  ┌───────────────┐                              │
│  │  File System  │  (JSON/Binary persistence)  │
│  │  Append-Log   │                              │
│  └───────────────┘                              │
└─────────────────────────────────────────────────┘
```

| Pros | Cons |
|------|------|
| Zero external dependencies | Single-process only |
| Simple deployment (npm install) | Must implement durability ourselves |
| No network latency | In-memory limited by RAM |
| Works offline | No built-in clustering |
| Easy to debug and test | Pub/Sub is process-local only |

**Future Benefits:**
- Can be bundled directly into npm package
- Perfect for serverless/edge functions
- Ideal for desktop apps (Electron)
- Simple backup (copy file)

---

### Architecture 2: Hybrid Memory + WAL (Write-Ahead Log)

**Description:** In-memory operations with a Write-Ahead Log for durability, similar to SQLite's approach.

```
┌─────────────────────────────────────────────────┐
│              BRI Engine (index.js)              │
└───────────────────────┬─────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│              Hybrid WAL Store                   │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │           In-Memory Index               │   │
│  │  Map<$ID, Document>                     │   │
│  │  Map<Type, Set<ID_suffix>>              │   │
│  └─────────────────────────────────────────┘   │
│                    │                            │
│           ┌───────┴───────┐                    │
│           ▼               ▼                    │
│  ┌─────────────┐  ┌─────────────┐              │
│  │  WAL File   │  │  Snapshot   │              │
│  │  (append)   │  │  (periodic) │              │
│  └─────────────┘  └─────────────┘              │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │  EventEmitter (process-local pub/sub)   │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

| Pros | Cons |
|------|------|
| Fast reads (in-memory) | More complex implementation |
| Durable writes (WAL) | WAL compaction needed |
| Crash recovery | Startup time grows with WAL size |
| ACID-like guarantees possible | More disk I/O |
| Proven pattern (SQLite, Redis AOF) | Snapshot coordination |

**Future Benefits:**
- Point-in-time recovery possible
- Can replay WAL for debugging
- Foundation for replication
- Predictable performance

#### Architecture 2: Detailed Design

##### Core Concept

The WAL (Write-Ahead Log) pattern ensures durability by writing all changes to a sequential log file BEFORE updating in-memory state. If the process crashes, we replay the log on startup to restore state.

```
WRITE PATH:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  BRI     │───▶│  Append  │───▶│  fsync   │───▶│  Update  │
│  Engine  │    │  to WAL  │    │  (flush) │    │  Memory  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │
                     ▼
              ┌──────────────┐
              │  Return OK   │
              │  to caller   │
              └──────────────┘

READ PATH:
┌──────────┐    ┌──────────┐    ┌──────────┐
│  BRI     │───▶│  Read    │───▶│  Return  │
│  Engine  │    │  Memory  │    │  Result  │
└──────────┘    └──────────┘    └──────────┘
```

##### WAL File Format

```
┌────────────────────────────────────────────────────────────────┐
│                         WAL Header                             │
├────────────────────────────────────────────────────────────────┤
│  Magic: "BRIWAL" (6 bytes)                                     │
│  Version: uint16 (2 bytes)                                     │
│  Created: uint64 timestamp (8 bytes)                           │
│  Checksum Algorithm: uint8 (1 byte) - 0=CRC32, 1=xxHash        │
├────────────────────────────────────────────────────────────────┤
│                         WAL Entry 1                            │
├────────────────────────────────────────────────────────────────┤
│  LSN (Log Sequence Number): uint64 (8 bytes)                   │
│  Timestamp: uint64 (8 bytes)                                   │
│  Operation: uint8 (1 byte)                                     │
│    - 0x01 = SET                                                │
│    - 0x02 = DELETE                                             │
│    - 0x03 = RENAME                                             │
│    - 0x04 = SADD                                               │
│    - 0x05 = SREM                                               │
│  Key Length: uint16 (2 bytes)                                  │
│  Value Length: uint32 (4 bytes)                                │
│  Key: variable bytes                                           │
│  Value: variable bytes (JSON for SET, empty for DELETE)        │
│  Checksum: uint32 (4 bytes) - covers this entry                │
├────────────────────────────────────────────────────────────────┤
│                         WAL Entry 2                            │
├────────────────────────────────────────────────────────────────┤
│  ... (same structure)                                          │
└────────────────────────────────────────────────────────────────┘
```

##### TypeScript Implementation Sketch

```typescript
interface WALEntry {
  lsn: bigint;              // Log Sequence Number
  timestamp: number;
  operation: WALOperation;
  key: string;
  value?: string;
}

enum WALOperation {
  SET = 0x01,
  DELETE = 0x02,
  RENAME = 0x03,
  SADD = 0x04,
  SREM = 0x05,
}

class WALStore implements StorageAdapter {
  private documents: Map<string, string> = new Map();
  private collections: Map<string, Set<string>> = new Map();
  private walFd: number;
  private currentLSN: bigint = 0n;
  private lastSnapshotLSN: bigint = 0n;

  // Configuration
  private readonly walPath: string;
  private readonly snapshotPath: string;
  private readonly snapshotThreshold: number = 10000; // entries before snapshot
  private readonly fsyncMode: 'always' | 'batched' | 'os' = 'batched';
  private readonly batchInterval: number = 100; // ms for batched fsync

  async connect(): Promise<void> {
    // 1. Load latest snapshot if exists
    await this.loadSnapshot();

    // 2. Replay WAL entries after snapshot LSN
    await this.replayWAL();

    // 3. Open WAL for appending
    this.walFd = await fs.open(this.walPath, 'a');

    // 4. Start background snapshot scheduler
    this.startSnapshotScheduler();
  }

  async set(key: string, value: string): Promise<void> {
    // 1. Write to WAL first (durability)
    await this.appendToWAL({
      lsn: ++this.currentLSN,
      timestamp: Date.now(),
      operation: WALOperation.SET,
      key,
      value
    });

    // 2. Update in-memory state
    this.documents.set(key, value);

    // 3. Check if snapshot needed
    this.maybeSnapshot();
  }

  async get(key: string): Promise<string | null> {
    // Direct memory read - O(1)
    return this.documents.get(key) ?? null;
  }

  private async appendToWAL(entry: WALEntry): Promise<void> {
    const buffer = this.serializeEntry(entry);
    await fs.write(this.walFd, buffer);

    if (this.fsyncMode === 'always') {
      await fs.fsync(this.walFd);
    }
    // 'batched' mode uses interval-based fsync
    // 'os' mode relies on OS buffer flushing
  }

  private async loadSnapshot(): Promise<void> {
    const snapshotFiles = await glob('snapshot_*.db', this.dataDir);
    if (snapshotFiles.length === 0) return;

    // Load most recent snapshot
    const latest = snapshotFiles.sort().pop()!;
    const data = await fs.readFile(latest);
    const snapshot = this.deserializeSnapshot(data);

    this.documents = new Map(Object.entries(snapshot.documents));
    this.collections = new Map(
      Object.entries(snapshot.collections).map(
        ([k, v]) => [k, new Set(v as string[])]
      )
    );
    this.lastSnapshotLSN = snapshot.lsn;
    this.currentLSN = snapshot.lsn;
  }

  private async replayWAL(): Promise<void> {
    if (!await fs.exists(this.walPath)) return;

    const walData = await fs.readFile(this.walPath);
    const entries = this.parseWAL(walData);

    for (const entry of entries) {
      if (entry.lsn <= this.lastSnapshotLSN) continue; // Skip already snapshotted

      this.applyEntry(entry); // Update in-memory state
      this.currentLSN = entry.lsn;
    }

    console.log(`Replayed ${entries.length} WAL entries`);
  }

  private async createSnapshot(): Promise<void> {
    const snapshot = {
      lsn: this.currentLSN,
      timestamp: Date.now(),
      documents: Object.fromEntries(this.documents),
      collections: Object.fromEntries(
        [...this.collections].map(([k, v]) => [k, [...v]])
      )
    };

    const snapshotPath = `snapshot_${Date.now()}.db`;

    // Atomic write: write to temp, then rename
    const tempPath = snapshotPath + '.tmp';
    await fs.writeFile(tempPath, this.serializeSnapshot(snapshot));
    await fs.rename(tempPath, snapshotPath);

    // Truncate WAL (entries now in snapshot)
    await fs.truncate(this.walPath, 0);
    this.lastSnapshotLSN = this.currentLSN;

    // Cleanup old snapshots (keep last 2)
    await this.cleanupOldSnapshots();
  }
}
```

##### Recovery Scenarios

```
SCENARIO 1: Clean Shutdown
┌────────────────────────────────────────────────────────────────┐
│  1. Stop accepting writes                                      │
│  2. Flush pending WAL entries                                  │
│  3. Create final snapshot                                      │
│  4. Close file handles                                         │
│  Result: Fast startup (just load snapshot)                     │
└────────────────────────────────────────────────────────────────┘

SCENARIO 2: Crash After WAL Write, Before Memory Update
┌────────────────────────────────────────────────────────────────┐
│  State at crash:                                               │
│    WAL: [SET US_abc "data"]  ✓ written                         │
│    Memory: US_abc = undefined (not updated yet)                │
│                                                                │
│  Recovery:                                                     │
│    1. Load snapshot (if exists)                                │
│    2. Replay WAL → applies SET US_abc "data"                   │
│    3. Memory now has US_abc = "data"  ✓                        │
│  Result: No data loss                                          │
└────────────────────────────────────────────────────────────────┘

SCENARIO 3: Crash During WAL Write (Partial Entry)
┌────────────────────────────────────────────────────────────────┐
│  State at crash:                                               │
│    WAL: [SET US_abc "da...  (incomplete, checksum fails)       │
│                                                                │
│  Recovery:                                                     │
│    1. Load snapshot                                            │
│    2. Parse WAL, detect corrupted entry via checksum           │
│    3. Discard corrupted entry, log warning                     │
│    4. Continue with last valid state                           │
│  Result: Lose only the in-flight write                         │
└────────────────────────────────────────────────────────────────┘

SCENARIO 4: Crash During Snapshot
┌────────────────────────────────────────────────────────────────┐
│  State at crash:                                               │
│    snapshot_new.db.tmp exists (incomplete)                     │
│    snapshot_old.db exists (valid)                              │
│    WAL has entries since snapshot_old                          │
│                                                                │
│  Recovery:                                                     │
│    1. Delete .tmp files (incomplete snapshots)                 │
│    2. Load snapshot_old.db                                     │
│    3. Replay full WAL                                          │
│  Result: No data loss (atomic rename protects us)              │
└────────────────────────────────────────────────────────────────┘
```

##### Fsync Modes Explained

```
┌─────────────────────────────────────────────────────────────────┐
│                     FSYNC MODE: 'always'                        │
├─────────────────────────────────────────────────────────────────┤
│  Every write:  write() → fsync() → return                       │
│                                                                 │
│  Durability: Maximum (survives power loss)                      │
│  Performance: ~1,000-5,000 writes/sec (limited by disk)         │
│  Use case: Financial data, can't lose any transaction           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     FSYNC MODE: 'batched'                       │
├─────────────────────────────────────────────────────────────────┤
│  Writes: write() → buffer → return immediately                  │
│  Background: every 100ms → fsync() all buffered                 │
│                                                                 │
│  Durability: Good (lose max 100ms of writes on power loss)      │
│  Performance: ~50,000-100,000 writes/sec                        │
│  Use case: Most applications (recommended default)              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     FSYNC MODE: 'os'                            │
├─────────────────────────────────────────────────────────────────┤
│  Writes: write() → return (OS decides when to flush)            │
│                                                                 │
│  Durability: Low (OS may buffer for seconds)                    │
│  Performance: ~200,000+ writes/sec                              │
│  Use case: Development, ephemeral data, caches                  │
└─────────────────────────────────────────────────────────────────┘
```

##### Snapshot Strategies

```
STRATEGY 1: Size-Based Threshold
─────────────────────────────────
Trigger snapshot when WAL exceeds N entries or M megabytes.

  if (walEntryCount > 10000 || walFileSize > 100MB) {
    createSnapshot();
  }

Pro: Predictable WAL size
Con: Snapshot timing unpredictable under varying load


STRATEGY 2: Time-Based Interval
───────────────────────────────
Snapshot every N minutes regardless of activity.

  setInterval(() => createSnapshot(), 5 * 60 * 1000);

Pro: Predictable timing, good for backups
Con: May create unnecessary snapshots during low activity


STRATEGY 3: Hybrid (Recommended)
───────────────────────────────
Combine both: snapshot if threshold exceeded OR interval passed.

  const shouldSnapshot =
    walEntryCount > 10000 ||
    Date.now() - lastSnapshotTime > 5 * 60 * 1000;

Pro: Best of both worlds
Con: Slightly more complex logic
```

---

### Architecture 3: LSM-Tree Based Store

**Description:** Log-Structured Merge-tree for high write throughput with sorted key access.

```
┌─────────────────────────────────────────────────┐
│              BRI Engine (index.js)              │
└───────────────────────┬─────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│              LSM-Tree Store                     │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │         MemTable (sorted)               │   │
│  │    Red-Black Tree / Skip List           │   │
│  └─────────────────────────────────────────┘   │
│                    │ flush when full            │
│                    ▼                            │
│  ┌─────────────────────────────────────────┐   │
│  │         SSTable Files (L0)              │   │
│  │    Sorted, immutable segments           │   │
│  └─────────────────────────────────────────┘   │
│                    │ compaction                 │
│                    ▼                            │
│  ┌─────────────────────────────────────────┐   │
│  │    SSTable Files (L1, L2, ...)          │   │
│  │    Merged, larger segments              │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  Bloom filters for fast negative lookups       │
└─────────────────────────────────────────────────┘
```

| Pros | Cons |
|------|------|
| Excellent write throughput | More complex than WAL |
| Sorted iteration (range queries) | Read amplification |
| Space efficient (compression) | Compaction overhead |
| Scales to large datasets | Background threads needed |
| Industry proven (LevelDB, RocksDB) | Harder to implement correctly |

**Future Benefits:**
- Handles datasets larger than RAM
- Built-in compression saves disk
- Range scans by type prefix efficient
- Foundation for secondary indexes

#### Architecture 3: Detailed Design

##### Core Concept

LSM-Tree (Log-Structured Merge-Tree) optimizes for write-heavy workloads by:
1. Buffering writes in memory (MemTable)
2. Flushing to sorted, immutable files (SSTables) when full
3. Periodically merging SSTables to reduce read amplification

```
WRITE PATH (Optimized for Speed):
┌──────────┐    ┌──────────────┐    ┌──────────────┐
│  BRI     │───▶│   Write to   │───▶│   Return OK  │
│  Engine  │    │   MemTable   │    │   (fast!)    │
└──────────┘    └──────────────┘    └──────────────┘
                      │
                      │ (async, when MemTable full)
                      ▼
               ┌──────────────┐
               │  Flush to    │
               │  SSTable L0  │
               └──────────────┘

READ PATH (May Check Multiple Levels):
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  BRI     │───▶│ MemTable │───▶│  L0      │───▶│  L1...   │
│  Engine  │    │  (RAM)   │    │  (disk)  │    │  (disk)  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                    │               │               │
                    └───────────────┴───────────────┘
                              │
                              ▼ (first match wins)
                       ┌──────────────┐
                       │   Return     │
                       │   Result     │
                       └──────────────┘
```

##### LSM-Tree Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                          MEMORY                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Active MemTable (4MB default)                          │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │  Skip List / Red-Black Tree (sorted by key)     │   │   │
│  │  │                                                  │   │   │
│  │  │  FR_0001 → {"name":"Alice"...}                  │   │   │
│  │  │  FR_0002 → {"name":"Bob"...}                    │   │   │
│  │  │  US_0001 → {"email":"..."...}                   │   │   │
│  │  │  US_0002 → {"email":"..."...}                   │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Immutable MemTable (being flushed to L0)               │   │
│  │  (frozen while flush in progress)                       │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                           DISK                                  │
├─────────────────────────────────────────────────────────────────┤
│  Level 0 (L0): Recently flushed, may overlap                   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐              │
│  │ SST-001 │ │ SST-002 │ │ SST-003 │ │ SST-004 │              │
│  │ A-Z     │ │ A-M     │ │ F-Z     │ │ A-K     │  ← overlapping│
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘              │
│                         │                                       │
│                         │ compaction                            │
│                         ▼                                       │
│  Level 1 (L1): Merged, non-overlapping, ~10MB each             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                          │
│  │ SST-100 │ │ SST-101 │ │ SST-102 │                          │
│  │ A-F     │ │ G-M     │ │ N-Z     │  ← non-overlapping        │
│  └─────────┘ └─────────┘ └─────────┘                          │
│                         │                                       │
│                         │ compaction (when L1 too large)        │
│                         ▼                                       │
│  Level 2 (L2): Larger files, ~100MB each                       │
│  ┌───────────────┐ ┌───────────────┐                          │
│  │    SST-200    │ │    SST-201    │                          │
│  │     A-M       │ │     N-Z       │                          │
│  └───────────────┘ └───────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

##### SSTable File Format

```
┌────────────────────────────────────────────────────────────────┐
│                      SSTable File                              │
├────────────────────────────────────────────────────────────────┤
│  Header (32 bytes)                                             │
│  ├─ Magic: "BRISST" (6 bytes)                                  │
│  ├─ Version: uint16 (2 bytes)                                  │
│  ├─ Entry Count: uint32 (4 bytes)                              │
│  ├─ Min Key Length: uint16 + Min Key (variable)                │
│  ├─ Max Key Length: uint16 + Max Key (variable)                │
│  └─ Compression: uint8 (0=none, 1=snappy, 2=zstd)              │
├────────────────────────────────────────────────────────────────┤
│  Data Blocks (4KB each, compressed)                            │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Block 0:                                                 │ │
│  │  ├─ Entry: [key_len][key][val_len][value][tombstone_flag] │ │
│  │  ├─ Entry: ...                                            │ │
│  │  └─ Block Checksum: uint32                                │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │  Block 1: ...                                             │ │
│  └──────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│  Index Block                                                   │
│  ├─ Block 0: first_key, offset, size                          │
│  ├─ Block 1: first_key, offset, size                          │
│  └─ ...                                                        │
├────────────────────────────────────────────────────────────────┤
│  Bloom Filter (for fast negative lookups)                      │
│  └─ Bit array (10 bits per key typical)                        │
├────────────────────────────────────────────────────────────────┤
│  Footer                                                        │
│  ├─ Index Block Offset: uint64                                 │
│  ├─ Bloom Filter Offset: uint64                                │
│  └─ File Checksum: uint32                                      │
└────────────────────────────────────────────────────────────────┘
```

##### TypeScript Implementation Sketch

```typescript
interface LSMConfig {
  memtableSize: number;        // Default: 4MB
  l0CompactionTrigger: number; // Compact when L0 has this many files
  levelSizeMultiplier: number; // Each level is N times larger
  blockSize: number;           // Default: 4KB
  bloomFilterBitsPerKey: number; // Default: 10
}

class LSMStore implements StorageAdapter {
  private activeMemtable: SkipList<string, string>;
  private immutableMemtables: SkipList<string, string>[] = [];
  private levels: SSTableLevel[] = [];
  private config: LSMConfig;

  // For BRI's set operations (collections)
  private collectionMemtable: SkipList<string, Set<string>>;

  async set(key: string, value: string): Promise<void> {
    // 1. Write to active MemTable (in-memory, very fast)
    this.activeMemtable.put(key, value);

    // 2. Also write to WAL for durability (can be async/batched)
    await this.wal.append({ op: 'SET', key, value });

    // 3. Check if MemTable needs flush
    if (this.activeMemtable.size >= this.config.memtableSize) {
      await this.rotateMemtable();
    }
  }

  async get(key: string): Promise<string | null> {
    // 1. Check active MemTable first (most recent writes)
    let value = this.activeMemtable.get(key);
    if (value !== undefined) {
      return value === TOMBSTONE ? null : value;
    }

    // 2. Check immutable MemTables (being flushed)
    for (const memtable of this.immutableMemtables) {
      value = memtable.get(key);
      if (value !== undefined) {
        return value === TOMBSTONE ? null : value;
      }
    }

    // 3. Check SSTables level by level (L0, L1, L2, ...)
    for (const level of this.levels) {
      value = await level.get(key);
      if (value !== undefined) {
        return value === TOMBSTONE ? null : value;
      }
    }

    return null; // Key not found
  }

  async delete(key: string): Promise<void> {
    // Write a "tombstone" marker (special value indicating deletion)
    await this.set(key, TOMBSTONE);
  }

  private async rotateMemtable(): Promise<void> {
    // 1. Freeze current MemTable
    const toFlush = this.activeMemtable;
    this.immutableMemtables.push(toFlush);

    // 2. Create new active MemTable
    this.activeMemtable = new SkipList();

    // 3. Trigger background flush (don't await)
    this.flushMemtable(toFlush);
  }

  private async flushMemtable(memtable: SkipList): Promise<void> {
    // 1. Create new SSTable file from sorted MemTable entries
    const sstable = await SSTable.createFromMemtable(
      memtable,
      this.config.blockSize,
      this.config.bloomFilterBitsPerKey
    );

    // 2. Add to L0
    this.levels[0].addSSTable(sstable);

    // 3. Remove from immutable list
    const idx = this.immutableMemtables.indexOf(memtable);
    this.immutableMemtables.splice(idx, 1);

    // 4. Maybe trigger compaction
    if (this.levels[0].fileCount >= this.config.l0CompactionTrigger) {
      this.scheduleCompaction(0);
    }
  }
}

class SSTableLevel {
  private sstables: SSTable[] = [];
  private levelNum: number;

  async get(key: string): Promise<string | undefined> {
    if (this.levelNum === 0) {
      // L0: Files may overlap, check all (newest first)
      for (let i = this.sstables.length - 1; i >= 0; i--) {
        const value = await this.sstables[i].get(key);
        if (value !== undefined) return value;
      }
    } else {
      // L1+: Files don't overlap, binary search for correct file
      const sstable = this.findSSTableForKey(key);
      if (sstable) {
        return await sstable.get(key);
      }
    }
    return undefined;
  }
}

class SSTable {
  private bloomFilter: BloomFilter;
  private index: { firstKey: string; offset: number; size: number }[];
  private filePath: string;

  async get(key: string): Promise<string | undefined> {
    // 1. Check Bloom filter first (fast negative lookup)
    if (!this.bloomFilter.mayContain(key)) {
      return undefined; // Definitely not in this SSTable
    }

    // 2. Binary search index to find block
    const blockInfo = this.findBlockForKey(key);
    if (!blockInfo) return undefined;

    // 3. Read and decompress block from disk
    const block = await this.readBlock(blockInfo.offset, blockInfo.size);

    // 4. Binary search within block for key
    return this.searchBlock(block, key);
  }
}
```

##### Compaction Process

```
COMPACTION: Merge overlapping SSTables into larger, non-overlapping ones

L0 → L1 Compaction (most frequent):
┌─────────────────────────────────────────────────────────────────┐
│  BEFORE:                                                        │
│  L0: [A-Z] [A-M] [F-Z] [A-K]  ← 4 overlapping files             │
│  L1: [A-F] [G-M] [N-Z]        ← 3 non-overlapping files         │
│                                                                 │
│  COMPACTION PROCESS:                                            │
│  1. Select all L0 files + overlapping L1 files                  │
│  2. Merge-sort all entries by key                               │
│  3. For duplicate keys, keep newest (highest sequence number)   │
│  4. Remove tombstones for deleted keys                          │
│  5. Write new sorted, non-overlapping L1 files                  │
│                                                                 │
│  AFTER:                                                         │
│  L0: (empty)                                                    │
│  L1: [A-D] [E-H] [I-L] [M-P] [Q-T] [U-Z]  ← new non-overlapping │
└─────────────────────────────────────────────────────────────────┘

L1 → L2 Compaction (when L1 exceeds size limit):
┌─────────────────────────────────────────────────────────────────┐
│  Similar process, but:                                          │
│  - Only compact subset of L1 files (e.g., oldest or largest)    │
│  - Merge with overlapping L2 files only                         │
│  - Creates larger L2 files (~100MB vs ~10MB for L1)             │
└─────────────────────────────────────────────────────────────────┘
```

##### Bloom Filter Optimization

```
PURPOSE: Avoid disk reads for keys that definitely don't exist

WITHOUT BLOOM FILTER:
┌────────────────────────────────────────────────────────────────┐
│  get("US_nonexistent"):                                        │
│  1. Check MemTable (miss)           ~ 1μs                      │
│  2. Check L0 SSTable 1 (miss)       ~ 100μs (disk read)        │
│  3. Check L0 SSTable 2 (miss)       ~ 100μs (disk read)        │
│  4. Check L0 SSTable 3 (miss)       ~ 100μs (disk read)        │
│  5. Check L1 files (miss)           ~ 100μs (disk read)        │
│  Total: ~400μs for a miss!                                     │
└────────────────────────────────────────────────────────────────┘

WITH BLOOM FILTER:
┌────────────────────────────────────────────────────────────────┐
│  get("US_nonexistent"):                                        │
│  1. Check MemTable (miss)           ~ 1μs                      │
│  2. Bloom filter SST-1: NO          ~ 0.1μs (skip disk read!)  │
│  3. Bloom filter SST-2: NO          ~ 0.1μs (skip disk read!)  │
│  4. Bloom filter SST-3: NO          ~ 0.1μs (skip disk read!)  │
│  5. Bloom filter L1: NO             ~ 0.1μs (skip disk read!)  │
│  Total: ~1.5μs for a miss!                                     │
│                                                                │
│  False positive rate: ~1% (configurable via bits per key)      │
│  10 bits/key → ~1% false positive                              │
│  15 bits/key → ~0.1% false positive                            │
└────────────────────────────────────────────────────────────────┘
```

##### BRI-Specific Optimization: Prefix-Based Range Scans

```
BRI's sMembers("US?") needs all IDs for type "US"

TRADITIONAL APPROACH (scan all):
┌────────────────────────────────────────────────────────────────┐
│  Scan every SSTable looking for "US_*" keys                    │
│  Very slow for large databases                                 │
└────────────────────────────────────────────────────────────────┘

LSM-TREE ADVANTAGE (sorted keys):
┌────────────────────────────────────────────────────────────────┐
│  Keys are sorted! Range scan is efficient:                     │
│                                                                │
│  1. Find first key >= "US_" using index                        │
│  2. Iterate until key > "US_\xff" (end of US prefix)           │
│  3. Only read blocks containing "US_*" keys                    │
│                                                                │
│  For sMembers, we can store collection membership as:          │
│  Key: "SET:US?:abc1234" → Value: ""  (presence = membership)   │
│                                                                │
│  Range scan "SET:US?:" to "SET:US?:\xff" returns all members   │
└────────────────────────────────────────────────────────────────┘
```

##### Performance Characteristics

```
┌─────────────────────────────────────────────────────────────────┐
│                    LSM-TREE PERFORMANCE                         │
├─────────────────────────────────────────────────────────────────┤
│  WRITES:                                                        │
│  ├─ Random write: O(1) amortized (just append to MemTable)     │
│  ├─ Throughput: 100,000 - 500,000 writes/sec                   │
│  └─ Why fast: Sequential I/O only (no random seeks)            │
│                                                                 │
│  READS:                                                         │
│  ├─ Point lookup: O(log N) per level checked                   │
│  ├─ Best case: ~1μs (found in MemTable)                        │
│  ├─ Worst case: ~1ms (check all levels, disk reads)            │
│  ├─ Average: ~10-100μs (with Bloom filters)                    │
│  └─ Read amplification: May read multiple SSTables             │
│                                                                 │
│  RANGE SCANS:                                                   │
│  ├─ Very efficient due to sorted keys                          │
│  ├─ Perfect for BRI's type-based queries (all "US_*" keys)     │
│  └─ O(K) where K = number of keys in range                     │
│                                                                 │
│  SPACE:                                                         │
│  ├─ Write amplification: ~10-30x (data rewritten in compaction)│
│  ├─ But: Compression typically 2-5x reduction                  │
│  └─ Net: Usually more space-efficient than B-tree              │
└─────────────────────────────────────────────────────────────────┘
```

---

### Architecture 4: Actor-Based Store with Message Passing

**Description:** Separate storage into actors/workers for isolation and potential multi-process support.

```
┌─────────────────────────────────────────────────┐
│              BRI Engine (index.js)              │
└───────────────────────┬─────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│              Actor-Based Store                  │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────┐  ┌──────────────┐            │
│  │ Storage      │  │ PubSub       │            │
│  │ Actor        │  │ Actor        │            │
│  │ (Worker)     │  │ (Worker)     │            │
│  └──────┬───────┘  └──────┬───────┘            │
│         │                 │                     │
│         ▼                 ▼                     │
│  ┌──────────────┐  ┌──────────────┐            │
│  │ File/Memory  │  │ Subscribers  │            │
│  │ Backend      │  │ Registry     │            │
│  └──────────────┘  └──────────────┘            │
│                                                 │
│  Message Queue for inter-actor communication   │
└─────────────────────────────────────────────────┘
```

| Pros | Cons |
|------|------|
| Isolated failures | Message passing overhead |
| Can scale to multiple cores | More complex architecture |
| Clear separation of concerns | Serialization costs |
| Testable in isolation | Ordering guarantees harder |
| Potential for distributed | Debugging more difficult |

**Future Benefits:**
- Natural path to clustering
- Can move actors to separate processes
- Fault isolation
- Independent scaling of read/write

#### Architecture 4: Detailed Design

##### Core Concept

The Actor Model treats each component as an independent "actor" that:
1. Has its own private state (no shared memory)
2. Communicates only via asynchronous messages
3. Processes messages sequentially (no internal concurrency)
4. Can create child actors and supervise them

```
ACTOR MODEL PRINCIPLES:
┌─────────────────────────────────────────────────────────────────┐
│  1. NO SHARED STATE                                             │
│     Each actor owns its data exclusively                        │
│     No locks, no race conditions within an actor                │
│                                                                 │
│  2. MESSAGE PASSING                                             │
│     Actors communicate via immutable messages                   │
│     Sender doesn't wait (fire-and-forget or request/reply)      │
│                                                                 │
│  3. LOCATION TRANSPARENCY                                       │
│     Actor addresses work the same locally or remotely           │
│     Easy to distribute across processes/machines                │
│                                                                 │
│  4. SUPERVISION                                                 │
│     Parent actors supervise children                            │
│     Failure in child = parent decides how to handle             │
└─────────────────────────────────────────────────────────────────┘
```

##### Actor Hierarchy for BRI

```
┌─────────────────────────────────────────────────────────────────┐
│                      ROOT SUPERVISOR                            │
│                   (restarts failed children)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   STORAGE     │   │    PUBSUB     │   │   REPLICATOR  │
│   SUPERVISOR  │   │   SUPERVISOR  │   │  (future)     │
└───────┬───────┘   └───────┬───────┘   └───────────────┘
        │                   │
   ┌────┴────┐         ┌────┴────┐
   │         │         │         │
   ▼         ▼         ▼         ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ Shard│ │ Shard│ │Channel│ │Channel│
│ US_* │ │ FR_* │ │  US   │ │  FR   │
│Actor │ │Actor │ │ Actor │ │ Actor │
└──────┘ └──────┘ └──────┘ └──────┘
```

##### Message Types

```typescript
// ==================== STORAGE MESSAGES ====================

interface SetMessage {
  type: 'SET';
  requestId: string;
  key: string;
  value: string;
  replyTo: ActorRef;
}

interface GetMessage {
  type: 'GET';
  requestId: string;
  key: string;
  replyTo: ActorRef;
}

interface GetReply {
  type: 'GET_REPLY';
  requestId: string;
  value: string | null;
}

interface SAddMessage {
  type: 'SADD';
  requestId: string;
  set: string;
  member: string;
  replyTo: ActorRef;
}

interface SMembersMessage {
  type: 'SMEMBERS';
  requestId: string;
  set: string;
  replyTo: ActorRef;
}

// ==================== PUBSUB MESSAGES ====================

interface PublishMessage {
  type: 'PUBLISH';
  channel: string;
  message: string;
}

interface SubscribeMessage {
  type: 'SUBSCRIBE';
  channel: string;
  subscriber: ActorRef;
}

interface UnsubscribeMessage {
  type: 'UNSUBSCRIBE';
  channel: string;
  subscriber: ActorRef;
}

interface BroadcastMessage {
  type: 'BROADCAST';
  channel: string;
  message: string;
}

// ==================== SUPERVISION MESSAGES ====================

interface ChildFailed {
  type: 'CHILD_FAILED';
  child: ActorRef;
  error: Error;
}

interface RestartChild {
  type: 'RESTART_CHILD';
  child: ActorRef;
}
```

##### Actor Implementations

```typescript
// ==================== STORAGE SHARD ACTOR ====================

class StorageShardActor implements Actor {
  private documents: Map<string, string> = new Map();
  private collections: Map<string, Set<string>> = new Map();
  private wal: WALWriter;
  private keyPrefix: string; // e.g., "US_" - this shard handles US_* keys

  constructor(private context: ActorContext, keyPrefix: string) {
    this.keyPrefix = keyPrefix;
  }

  async receive(message: Message): Promise<void> {
    switch (message.type) {
      case 'SET':
        await this.handleSet(message as SetMessage);
        break;
      case 'GET':
        await this.handleGet(message as GetMessage);
        break;
      case 'SADD':
        await this.handleSAdd(message as SAddMessage);
        break;
      case 'SMEMBERS':
        await this.handleSMembers(message as SMembersMessage);
        break;
    }
  }

  private async handleSet(msg: SetMessage): Promise<void> {
    // Write to WAL first
    await this.wal.append({ op: 'SET', key: msg.key, value: msg.value });

    // Update in-memory state
    this.documents.set(msg.key, msg.value);

    // Reply to sender
    this.context.send(msg.replyTo, {
      type: 'SET_REPLY',
      requestId: msg.requestId,
      success: true
    });
  }

  private async handleGet(msg: GetMessage): Promise<void> {
    const value = this.documents.get(msg.key) ?? null;

    this.context.send(msg.replyTo, {
      type: 'GET_REPLY',
      requestId: msg.requestId,
      value
    });
  }
}

// ==================== PUBSUB CHANNEL ACTOR ====================

class PubSubChannelActor implements Actor {
  private subscribers: Set<ActorRef> = new Set();
  private channelName: string;

  constructor(private context: ActorContext, channelName: string) {
    this.channelName = channelName;
  }

  async receive(message: Message): Promise<void> {
    switch (message.type) {
      case 'SUBSCRIBE':
        this.subscribers.add((message as SubscribeMessage).subscriber);
        break;

      case 'UNSUBSCRIBE':
        this.subscribers.delete((message as UnsubscribeMessage).subscriber);
        break;

      case 'PUBLISH':
        // Broadcast to all subscribers
        const pubMsg = message as PublishMessage;
        for (const subscriber of this.subscribers) {
          this.context.send(subscriber, {
            type: 'BROADCAST',
            channel: this.channelName,
            message: pubMsg.message
          });
        }
        break;
    }
  }
}

// ==================== STORAGE ROUTER ACTOR ====================

class StorageRouterActor implements Actor {
  private shards: Map<string, ActorRef> = new Map();

  constructor(private context: ActorContext) {
    // Create shards for different type prefixes
    // Could be dynamic based on actual data distribution
  }

  async receive(message: Message): Promise<void> {
    if (message.type === 'SET' || message.type === 'GET') {
      const keyMsg = message as SetMessage | GetMessage;
      const prefix = this.getPrefix(keyMsg.key);
      const shard = this.getOrCreateShard(prefix);

      // Forward to appropriate shard
      this.context.send(shard, message);
    }
  }

  private getPrefix(key: string): string {
    // Extract type prefix: "US_abc1234" → "US"
    return key.split('_')[0];
  }

  private getOrCreateShard(prefix: string): ActorRef {
    if (!this.shards.has(prefix)) {
      const shard = this.context.spawn(
        StorageShardActor,
        `shard-${prefix}`,
        prefix
      );
      this.shards.set(prefix, shard);
    }
    return this.shards.get(prefix)!;
  }
}
```

##### Storage Adapter Bridge

```typescript
// Bridge between BRI's sync API and Actor-based async system

class ActorStorageAdapter implements StorageAdapter {
  private system: ActorSystem;
  private storageRouter: ActorRef;
  private pubsubRouter: ActorRef;
  private pendingRequests: Map<string, PromiseResolver> = new Map();

  async connect(): Promise<void> {
    this.system = new ActorSystem();

    // Spawn root actors
    this.storageRouter = this.system.spawn(StorageRouterActor, 'storage');
    this.pubsubRouter = this.system.spawn(PubSubRouterActor, 'pubsub');

    // Create reply handler actor (receives responses)
    this.replyHandler = this.system.spawn(ReplyHandlerActor, 'replies', this);
  }

  async set(key: string, value: string): Promise<void> {
    const requestId = generateId();

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
    });

    this.system.send(this.storageRouter, {
      type: 'SET',
      requestId,
      key,
      value,
      replyTo: this.replyHandler
    });

    return promise;
  }

  async get(key: string): Promise<string | null> {
    const requestId = generateId();

    const promise = new Promise<string | null>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
    });

    this.system.send(this.storageRouter, {
      type: 'GET',
      requestId,
      key,
      replyTo: this.replyHandler
    });

    return promise;
  }

  // Called by ReplyHandlerActor when response arrives
  handleReply(requestId: string, result: any): void {
    const resolver = this.pendingRequests.get(requestId);
    if (resolver) {
      this.pendingRequests.delete(requestId);
      resolver.resolve(result);
    }
  }
}
```

##### Node.js Worker Threads Implementation

```typescript
// ==================== WORKER THREAD ACTORS ====================

// Main thread: ActorSystem coordinator
class ActorSystem {
  private workers: Map<string, Worker> = new Map();
  private messageHandlers: Map<string, (msg: any) => void> = new Map();

  spawnOnWorker(actorType: string, actorId: string): ActorRef {
    // Create dedicated worker thread for this actor
    const worker = new Worker('./actor-worker.js', {
      workerData: { actorType, actorId }
    });

    worker.on('message', (msg) => {
      this.routeMessage(msg);
    });

    worker.on('error', (err) => {
      this.handleWorkerError(actorId, err);
    });

    this.workers.set(actorId, worker);

    return { actorId, worker };
  }

  send(actorRef: ActorRef, message: Message): void {
    const worker = this.workers.get(actorRef.actorId);
    if (worker) {
      worker.postMessage(message);
    }
  }
}

// actor-worker.js (runs in Worker thread)
const { parentPort, workerData } = require('worker_threads');

const { actorType, actorId } = workerData;

// Instantiate the appropriate actor
let actor;
switch (actorType) {
  case 'StorageShard':
    actor = new StorageShardActor(actorId);
    break;
  case 'PubSubChannel':
    actor = new PubSubChannelActor(actorId);
    break;
}

// Message loop
parentPort.on('message', async (msg) => {
  const reply = await actor.receive(msg);
  if (reply) {
    parentPort.postMessage(reply);
  }
});
```

##### Supervision and Fault Tolerance

```
SUPERVISION STRATEGIES:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. ONE-FOR-ONE: Restart only the failed actor                  │
│  ───────────────────────────────────────────────────────────── │
│     Good for: Independent actors (storage shards)               │
│                                                                 │
│     [Shard A] [Shard B] [Shard C]                              │
│                   │                                             │
│                   ✗ fails                                       │
│                   │                                             │
│                   ▼                                             │
│     [Shard A] [Shard B'] [Shard C]  ← only B restarted         │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  2. ALL-FOR-ONE: Restart all children if one fails              │
│  ───────────────────────────────────────────────────────────── │
│     Good for: Interdependent actors                             │
│                                                                 │
│     [Writer] [Reader] [Indexer]                                │
│        │                                                        │
│        ✗ fails                                                  │
│        │                                                        │
│        ▼                                                        │
│     [Writer'] [Reader'] [Indexer']  ← all restarted            │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  3. ESCALATE: Pass failure to parent supervisor                 │
│  ───────────────────────────────────────────────────────────── │
│     Good for: Unrecoverable errors                              │
│                                                                 │
│     If restart fails N times → escalate to parent               │
│     Parent may restart entire subsystem                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
class StorageSupervisor implements Actor {
  private restartCounts: Map<string, number> = new Map();
  private maxRestarts = 3;
  private restartWindow = 60000; // 1 minute

  async receive(message: Message): Promise<void> {
    if (message.type === 'CHILD_FAILED') {
      const { child, error } = message as ChildFailed;
      await this.handleChildFailure(child, error);
    }
  }

  private async handleChildFailure(child: ActorRef, error: Error): Promise<void> {
    const restarts = this.restartCounts.get(child.actorId) || 0;

    if (restarts < this.maxRestarts) {
      // Try to restart
      console.log(`Restarting ${child.actorId} (attempt ${restarts + 1})`);
      this.restartCounts.set(child.actorId, restarts + 1);

      this.context.send(child, { type: 'RESTART' });

      // Reset counter after window
      setTimeout(() => {
        this.restartCounts.set(child.actorId, 0);
      }, this.restartWindow);

    } else {
      // Too many restarts, escalate
      console.error(`${child.actorId} failed ${this.maxRestarts} times, escalating`);
      this.context.send(this.context.parent, {
        type: 'CHILD_FAILED',
        child: this.context.self,
        error: new Error(`Supervision escalation: ${error.message}`)
      });
    }
  }
}
```

##### Distributed Actor System (Future)

```
SCALING TO MULTIPLE NODES:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Node 1 (Primary)              Node 2 (Secondary)               │
│  ┌─────────────────────┐      ┌─────────────────────┐          │
│  │ ┌─────┐ ┌─────┐    │      │ ┌─────┐ ┌─────┐    │          │
│  │ │US_* │ │FR_* │    │      │ │DE_* │ │JP_* │    │          │
│  │ │Shard│ │Shard│    │      │ │Shard│ │Shard│    │          │
│  │ └─────┘ └─────┘    │      │ └─────┘ └─────┘    │          │
│  │                     │      │                     │          │
│  │ ┌─────────────────┐│      │ ┌─────────────────┐│          │
│  │ │ Cluster Manager ││◀────▶│ │ Cluster Manager ││          │
│  │ └─────────────────┘│      │ └─────────────────┘│          │
│  └─────────────────────┘      └─────────────────────┘          │
│            │                            │                       │
│            └────────────┬───────────────┘                       │
│                         │                                       │
│                         ▼                                       │
│              ┌─────────────────────┐                           │
│              │   Message Transport  │                           │
│              │   (TCP/WebSocket)    │                           │
│              └─────────────────────┘                           │
│                                                                 │
│  Location transparency: ActorRef works across nodes             │
│  Message routing: Cluster Manager knows where actors live       │
│  Failover: Shard can be migrated to another node               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

##### Performance Characteristics

```
┌─────────────────────────────────────────────────────────────────┐
│                  ACTOR MODEL PERFORMANCE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  MESSAGE OVERHEAD:                                              │
│  ├─ In-process (same thread): ~0.1-1μs per message             │
│  ├─ Worker thread: ~10-50μs per message (serialization)        │
│  ├─ Cross-process: ~100-500μs per message                      │
│  └─ Cross-network: ~1-10ms per message (network latency)       │
│                                                                 │
│  THROUGHPUT:                                                    │
│  ├─ Single actor: 100,000-1,000,000 messages/sec               │
│  ├─ With worker threads: 10,000-100,000 messages/sec           │
│  └─ Scales horizontally with more actors/nodes                  │
│                                                                 │
│  LATENCY vs SINGLE-THREADED:                                    │
│  ├─ Simple get: +10-50μs overhead (message round-trip)         │
│  ├─ Complex query: May be faster (parallel across shards)       │
│  └─ Under load: Better (no lock contention)                    │
│                                                                 │
│  MEMORY:                                                        │
│  ├─ Per actor: ~1KB base + state                               │
│  ├─ Message queues: Bounded (back-pressure)                    │
│  └─ Worker threads: ~2MB each (V8 isolate overhead)            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

##### When to Choose Actor Model

```
GOOD FIT FOR BRI IF:
┌─────────────────────────────────────────────────────────────────┐
│  ✓ Need to scale beyond single process                          │
│  ✓ Want fault isolation (one shard failure doesn't crash all)   │
│  ✓ Planning distributed deployment                              │
│  ✓ Have natural partitioning (type prefixes = shards)           │
│  ✓ PubSub is important (actors excel at message routing)        │
│  ✓ Team comfortable with async/event-driven patterns            │
└─────────────────────────────────────────────────────────────────┘

POOR FIT FOR BRI IF:
┌─────────────────────────────────────────────────────────────────┐
│  ✗ Simple single-node deployment                                │
│  ✗ Low latency is critical (message overhead)                   │
│  ✗ Small dataset (overhead not worth it)                        │
│  ✗ Team unfamiliar with actor model                             │
│  ✗ Tight deadline (more complex to implement correctly)         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Persistent Store Proposals

### Store 1: JSON File Store (Simple)

**Description:** Each document stored as a separate JSON file, with index files for sets.

```
data/
├── documents/
│   ├── US_abc1234.json
│   ├── US_def5678.json
│   ├── FR_ghi9012.json
│   └── X:US_old1111:X.json   (soft deleted)
├── collections/
│   ├── US.json               ["abc1234", "def5678"]
│   └── FR.json               ["ghi9012"]
└── meta.json                 (last write timestamp, etc)
```

| Pros | Cons |
|------|------|
| Human readable | Many small files = slow |
| Easy debugging | No atomic multi-key ops |
| Git-friendly (diff-able) | File system limits (inodes) |
| Simple implementation | Poor performance at scale |
| No binary dependencies | Directory traversal overhead |

**Best For:** Development, small datasets (<1000 docs), debugging

---

### Store 2: Single Binary File with Index (Recommended)

**Description:** All data in one binary file with in-memory index, similar to SQLite's page-based approach.

```
┌────────────────────────────────────────────────────────────┐
│                    bri.db (binary file)                    │
├────────────────────────────────────────────────────────────┤
│ Header (magic, version, index offset)                      │
├────────────────────────────────────────────────────────────┤
│ Record: [length][flags][key_len][key][value]               │
│ Record: [length][flags][key_len][key][value]               │
│ Record: ...                                                │
├────────────────────────────────────────────────────────────┤
│ Tombstones (deleted record markers)                        │
├────────────────────────────────────────────────────────────┤
│ Index: offset map for fast lookups                         │
├────────────────────────────────────────────────────────────┤
│ Footer (checksum, record count)                            │
└────────────────────────────────────────────────────────────┘

In-Memory on startup:
┌─────────────────────────────────────┐
│ Map<$ID, {offset, length}>          │  Fast key lookup
│ Map<Type, Set<ID_suffix>>           │  Collection index
└─────────────────────────────────────┘
```

| Pros | Cons |
|------|------|
| Single file = simple backup | Custom format to maintain |
| Fast random access | Compaction needed periodically |
| Efficient disk usage | More complex than JSON files |
| Atomic writes possible | Binary = not human readable |
| Scales to millions of docs | Index must fit in memory |

**Best For:** Production use, medium datasets (up to millions of docs)

---

### Store 3: Append-Only Log with Snapshots

**Description:** All writes append to a log file; periodic snapshots for fast startup.

```
┌────────────────────────────────────────────────────────────┐
│                    data/                                   │
├────────────────────────────────────────────────────────────┤
│  current.log        (append-only operations log)          │
│  ├─ SET US_abc1234 {"name":"John"...}                     │
│  ├─ SADD US? abc1234                                      │
│  ├─ SET US_abc1234 {"name":"Johnny"...}                   │
│  └─ ...                                                   │
│                                                           │
│  snapshot_1704067200.db   (binary snapshot at timestamp)  │
│  snapshot_1704153600.db   (newer snapshot)                │
└────────────────────────────────────────────────────────────┘

Recovery:
1. Load latest snapshot into memory
2. Replay log entries after snapshot timestamp
3. Ready to serve
```

| Pros | Cons |
|------|------|
| Never lose data (append-only) | Log grows unbounded |
| Natural audit trail | Startup slower than binary |
| Easy replication (ship log) | Snapshot coordination |
| Crash safe | Disk usage higher |
| Can replay history | Compaction complexity |

**Best For:** High-reliability needs, audit requirements, replication scenarios

---

## Selected Store: Append-Only Log + Snapshots with @diff Integration

### Why This Store is Perfect for BRI

BRI uses a custom `@diff` package ([diff/index.js](diff/index.js)) that provides proxy-based change tracking with tuple-based patches. The Append-Only Log naturally extends this by storing **change tuples instead of full documents**, creating an event-sourced architecture.

#### @diff Package Overview

The `@diff` package is an RFC6902 alternative that uses:
- **Array paths**: `["users", 0, "name"]` instead of `/users/0/name`
- **Tuple changes**: `[path, newValue, oldValue]` - includes old value for instant reversal
- **UNDECLARED symbol**: Marks deletions and non-existent properties
- **Proxy-based tracking**: Built-in change tracking via `createChangeTracker()`

```typescript
// @diff API
import { createChangeTracker, applyChanges, UNDECLARED } from '@diff';

const tracked = createChangeTracker(obj, { onSave: (changes) => {...} });
tracked.name = "John";           // Change tracked automatically
tracked.getChanges();            // [[["name"], "John", UNDECLARED]]
tracked.save();                  // Triggers onSave callback, clears changes

applyChanges(changes, source);   // Apply changes to rebuild state
```

```
CURRENT BRI FLOW (with Redis):
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Change  │───▶│getChanges│───▶│  Publish │───▶│  Store   │
│  Object  │    │ (@diff)  │    │  to Redis│    │  Full Doc│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │
                     └─── Diff is CREATED but only used for pub/sub

NEW BRI FLOW (with Append-Only Log):
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Change  │───▶│getChanges│───▶│  Append  │───▶│  Update  │
│  Object  │    │ (@diff)  │    │  to Log  │    │  Memory  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                     │               │
                     │               └─── Changes ARE the storage format
                     │
                     └─── Same diff used for BOTH persistence AND pub/sub
```

### Advantages of @diff Over RFC6902

| Feature | RFC6902 | @diff |
|---------|---------|-------|
| Path format | String `/users/0/name` | Array `["users", 0, "name"]` |
| Old value | Not included | Included in tuple |
| Reversal | Requires computing inverse | Instant (swap new/old) |
| Parsing | String manipulation | Native JS array |
| Deletion | `{ op: "remove" }` | `[path, UNDECLARED, oldValue]` |
| Tracking | Separate `createPatch()` call | Built-in proxy |

### Event-Sourced Log Format

Using @diff's tuple-based changes: `[path, newValue, oldValue]`

```
┌────────────────────────────────────────────────────────────────┐
│                    events.log (append-only)                    │
├────────────────────────────────────────────────────────────────┤
│ Entry 1: CREATE                                                │
│ {                                                              │
│   "lsn": 1,                                                    │
│   "timestamp": "2024-01-15T10:00:00.000Z",                    │
│   "action": "CREATE",                                          │
│   "target": "US_abc1234",                                      │
│   "changes": [                                                 │
│     [["$ID"], "US_abc1234", UNDECLARED],                       │
│     [["name"], "John", UNDECLARED],                            │
│     [["email"], "john@...", UNDECLARED],                       │
│     [["createdAt"], "...", UNDECLARED]                         │
│   ],                                                           │
│   "saveBy": "US_admin001"                                      │
│ }                                                              │
├────────────────────────────────────────────────────────────────┤
│ Entry 2: UPDATE (only the diff!)                               │
│ {                                                              │
│   "lsn": 2,                                                    │
│   "timestamp": "2024-01-15T10:05:00.000Z",                    │
│   "action": "UPDATE",                                          │
│   "target": "US_abc1234",                                      │
│   "changes": [                                                 │
│     [["name"], "Johnny", "John"],       ← old value included!  │
│     [["age"], 30, UNDECLARED]           ← new field            │
│   ],                                                           │
│   "saveBy": "US_abc1234"                                       │
│ }                                                              │
├────────────────────────────────────────────────────────────────┤
│ Entry 3: UPDATE                                                │
│ {                                                              │
│   "lsn": 3,                                                    │
│   "changes": [                                                 │
│     [["email"], "j@...", "john@..."]    ← instant reversal!    │
│   ],                                                           │
│   ...                                                          │
│ }                                                              │
├────────────────────────────────────────────────────────────────┤
│ Entry 4: DELETE (soft delete via change)                       │
│ {                                                              │
│   "lsn": 4,                                                    │
│   "action": "DELETE",                                          │
│   "target": "US_abc1234",                                      │
│   "changes": [                                                 │
│     [["deletedAt"], "...", UNDECLARED],                        │
│     [["deletedBy"], "US_...", UNDECLARED]                      │
│   ],                                                           │
│   ...                                                          │
│ }                                                              │
└────────────────────────────────────────────────────────────────┘
```

**Key Benefit:** Old values are stored in every change tuple, enabling **instant undo/reversal** by simply swapping `newValue` and `oldValue` positions - no need to look up previous state.

### Benefits of Change-Based Storage

```
┌─────────────────────────────────────────────────────────────────┐
│                    STORAGE EFFICIENCY                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  FULL DOCUMENT STORAGE (traditional):                           │
│  ─────────────────────────────────────                          │
│  Update 1: {"$ID":"US_abc","name":"John","email":"j@x.com"...} │
│  Update 2: {"$ID":"US_abc","name":"Johnny","email":"j@x.com"...}│
│  Update 3: {"$ID":"US_abc","name":"Johnny","email":"jj@y.com"...}│
│                                                                 │
│  Total: ~300 bytes per update (redundant data)                  │
│                                                                 │
│  CHANGE-BASED STORAGE (@diff event-sourced):                    │
│  ───────────────────────────────────────────                    │
│  Create:  [[["name"],"John",∅], [["email"],"j@x.com",∅],...]   │
│  Update 1: [[["name"],"Johnny","John"]]           ~40 bytes     │
│  Update 2: [[["email"],"jj@y.com","j@x.com"]]     ~50 bytes     │
│                                                                 │
│  Total: ~240 bytes for 3 versions (35% smaller)                 │
│  BONUS: Old values included for free reversal!                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    UNIFIED DIFF SYSTEM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SAME @diff CHANGE TUPLES USED FOR:                             │
│  ├─ Storage (append to log)                                     │
│  ├─ Pub/Sub (broadcast to subscribers)                          │
│  ├─ Replication (ship log to replicas)                          │
│  ├─ Conflict resolution (merge by path)                         │
│  ├─ Time travel (replay changes forward)                        │
│  └─ Undo (swap newValue ↔ oldValue, instant!)                   │
│                                                                 │
│  Single source of truth for all change tracking!                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Impact on Architecture Proposals

---

#### Architecture 2 + Append-Only Log: **EXCELLENT FIT**

The Hybrid Memory + WAL architecture becomes even simpler when the WAL IS the append-only log:

```
┌─────────────────────────────────────────────────────────────────┐
│          ARCHITECTURE 2 WITH APPEND-ONLY LOG                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   In-Memory State                        │   │
│  │  ┌─────────────────────┐  ┌─────────────────────┐       │   │
│  │  │ documents:          │  │ collections:        │       │   │
│  │  │ Map<$ID, Document>  │  │ Map<Type, Set<ID>>  │       │   │
│  │  └─────────────────────┘  └─────────────────────┘       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ rebuild via applyChanges()       │
│                              │                                  │
│  ┌───────────────────────────┴─────────────────────────────┐   │
│  │                 Append-Only Event Log                    │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │   │
│  │  │ CREATE  │ │ UPDATE  │ │ UPDATE  │ │ DELETE  │       │   │
│  │  │(patches)│ │(patches)│ │(patches)│ │(patches)│       │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │   │
│  │                                                         │   │
│  │  Same format as BRI's pub/sub messages!                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ periodic                         │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Snapshot (materialized view)                │   │
│  │  Full document state at LSN X                            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

SYNERGY POINTS:
✓ BRI's getChanges() output goes DIRECTLY to log (no transformation)
✓ Log entries ARE the pub/sub messages (unified format)
✓ applyChanges() rebuilds state from log (@diff has this built-in)
✓ Snapshots are just materialized views of applied changes
✓ Old values in tuples enable instant reversal!
```

**TypeScript Implementation with @diff:**

```typescript
import { createChangeTracker, applyChanges, UNDECLARED, type Change } from '@diff';

interface LogEntry {
  lsn: bigint;
  timestamp: Date;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  target: string;  // $ID
  changes: Change[];  // @diff tuples: [path, newValue, oldValue]
  saveBy?: string;
  tag?: string;
}

class EventSourcedStore implements StorageAdapter {
  private documents: Map<string, object> = new Map();
  private collections: Map<string, Set<string>> = new Map();
  private log: AppendOnlyLog;
  private currentLSN: bigint = 0n;

  async set(key: string, value: string): Promise<void> {
    const newDoc = JSON.parse(value);
    const oldDoc = this.documents.get(key) || {};

    // Use @diff's proxy tracker to generate changes
    const tracker = createChangeTracker(structuredClone(oldDoc));
    Object.assign(tracker, newDoc);  // Apply all changes
    const changes = tracker.getChanges();

    if (changes.length === 0) return; // No changes

    // Append to log
    const entry: LogEntry = {
      lsn: ++this.currentLSN,
      timestamp: new Date(),
      action: this.documents.has(key) ? 'UPDATE' : 'CREATE',
      target: key,
      changes  // Tuples include old values!
    };

    await this.log.append(entry);

    // Update in-memory state
    this.documents.set(key, newDoc);

    // Pub/sub: entry IS the message (no conversion needed!)
    this.pubsub.publish(key.split('_')[0], entry);
  }

  // Rebuild state from log (recovery or replica sync)
  private async replayLog(fromLSN: bigint): Promise<void> {
    for await (const entry of this.log.readFrom(fromLSN)) {
      let doc = this.documents.get(entry.target) || {};

      // Apply changes using @diff
      const overlay = applyChanges(entry.changes, doc);
      Object.assign(doc, overlay);

      this.documents.set(entry.target, doc);
      this.currentLSN = entry.lsn;
    }
  }

  // BONUS: Instant undo by swapping tuple values!
  private reverseChanges(changes: Change[]): Change[] {
    return changes.map(([path, newVal, oldVal]) => [path, oldVal, newVal]);
  }
}
```

**Complexity Reduction:**

| Component | Without @diff Integration | With @diff Integration |
|-----------|---------------------------|------------------------|
| Log format | Custom binary/JSON | Reuse BRI's existing format |
| Serialization | Custom encoder | `JSON.stringify(changes)` |
| Pub/Sub messages | Separate transformation | Log entry = message |
| State rebuild | Custom merge logic | `applyChanges()` from @diff |
| Undo/reversal | Compute inverse patches | Swap tuple values (instant!) |
| Conflict detection | Custom implementation | Compare by path arrays |

---

#### Architecture 3 + Append-Only Log: **GOOD FIT**

LSM-Tree can store patches instead of full documents, but adds complexity:

```
┌─────────────────────────────────────────────────────────────────┐
│          ARCHITECTURE 3 WITH APPEND-ONLY LOG                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OPTION A: Log as separate WAL (simpler)                        │
│  ─────────────────────────────────────────                      │
│  ┌─────────────┐                                                │
│  │ Event Log   │ ──────────────────────┐                        │
│  │ (patches)   │                        │ pub/sub               │
│  └──────┬──────┘                        ▼                       │
│         │ materialize          ┌─────────────────┐              │
│         ▼                      │  Subscribers    │              │
│  ┌─────────────┐               └─────────────────┘              │
│  │ LSM-Tree    │                                                │
│  │ (full docs) │ ← standard LSM operations                      │
│  └─────────────┘                                                │
│                                                                 │
│  Pro: LSM handles large datasets efficiently                    │
│  Con: Two storage systems to maintain                           │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OPTION B: Patches in LSM (complex)                             │
│  ──────────────────────────────────                             │
│  Key: "US_abc1234:v3"  → Value: [patches for v3]                │
│  Key: "US_abc1234:v2"  → Value: [patches for v2]                │
│  Key: "US_abc1234:v1"  → Value: [patches for v1]                │
│                                                                 │
│  Read = collect all versions + apply patches                    │
│                                                                 │
│  Pro: Single storage system                                     │
│  Con: Reads become expensive (must apply all patches)           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Recommendation:** Use Architecture 3 only if dataset exceeds RAM significantly. For most BRI use cases, Architecture 2 is simpler and sufficient.

---

#### Architecture 4 + Append-Only Log: **EXCELLENT FIT**

Actor model naturally fits event sourcing - each actor can maintain its own log:

```
┌─────────────────────────────────────────────────────────────────┐
│          ARCHITECTURE 4 WITH APPEND-ONLY LOG                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Each Shard Actor has its own append-only log:                  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Storage Router Actor                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                     │
│          ┌────────────────┼────────────────┐                   │
│          │                │                │                    │
│          ▼                ▼                ▼                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │  US Shard    │ │  FR Shard    │ │  DE Shard    │            │
│  │  Actor       │ │  Actor       │ │  Actor       │            │
│  ├──────────────┤ ├──────────────┤ ├──────────────┤            │
│  │ Memory:      │ │ Memory:      │ │ Memory:      │            │
│  │ US_* docs    │ │ FR_* docs    │ │ DE_* docs    │            │
│  ├──────────────┤ ├──────────────┤ ├──────────────┤            │
│  │ Log:         │ │ Log:         │ │ Log:         │            │
│  │ us_events.log│ │ fr_events.log│ │ de_events.log│            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│                                                                 │
│  BENEFITS:                                                      │
│  ✓ Logs are partitioned (parallel writes)                       │
│  ✓ Each shard can snapshot independently                        │
│  ✓ Failed shard recovers from its own log                       │
│  ✓ Easy replication (ship shard's log to replica)               │
│  ✓ Event messages flow naturally through actor system           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Event Flow in Actor System:**

```typescript
import { createChangeTracker, applyChanges, type Change } from '@diff';

class StorageShardActor implements Actor {
  private documents: Map<string, object> = new Map();
  private log: AppendOnlyLog;
  private pubsubActor: ActorRef;

  async receive(message: Message): Promise<void> {
    switch (message.type) {
      case 'SET':
        await this.handleSet(message as SetMessage);
        break;
      case 'REPLICATE':
        // Receive changes from another node
        await this.handleReplicate(message as ReplicateMessage);
        break;
    }
  }

  private async handleSet(msg: SetMessage): Promise<void> {
    const newDoc = JSON.parse(msg.value);
    const oldDoc = this.documents.get(msg.key) || {};

    // Generate changes using @diff
    const tracker = createChangeTracker(structuredClone(oldDoc));
    Object.assign(tracker, newDoc);
    const changes = tracker.getChanges();

    // Create log entry (same format as BRI pub/sub)
    const entry: LogEntry = {
      lsn: ++this.currentLSN,
      action: this.documents.has(msg.key) ? 'UPDATE' : 'CREATE',
      target: msg.key,
      changes,  // @diff tuples with old values included!
      timestamp: new Date()
    };

    // 1. Append to local log
    await this.log.append(entry);

    // 2. Update in-memory state
    const overlay = applyChanges(entry.changes, oldDoc);
    Object.assign(oldDoc, overlay);
    this.documents.set(msg.key, oldDoc);

    // 3. Forward to PubSub actor (entry IS the message!)
    this.context.send(this.pubsubActor, {
      type: 'PUBLISH',
      channel: msg.key.split('_')[0],
      message: JSON.stringify(entry)
    });

    // 4. Reply to caller
    this.context.send(msg.replyTo, {
      type: 'SET_REPLY',
      requestId: msg.requestId,
      success: true
    });
  }

  // BONUS: Handle undo requests by reversing changes
  private async handleUndo(msg: UndoMessage): Promise<void> {
    const entry = await this.log.getEntry(msg.lsn);
    const reversed = entry.changes.map(([path, newVal, oldVal]) =>
      [path, oldVal, newVal] as Change
    );
    // Apply reversed changes...
  }
}
```

---

### Recommended Combination

Based on BRI's `@diff` package AND the [roadmap.md](roadmap.md) future features:

```
┌─────────────────────────────────────────────────────────────────┐
│                    RECOMMENDED STACK                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PHASE 1 (Simple, single-node):                                 │
│  ───────────────────────────────                                │
│  Architecture: 2 (Hybrid Memory + WAL)                          │
│  Store: Append-Only Log with Snapshots                          │
│  Language: TypeScript                                           │
│  Diff Package: @diff (tuple-based changes)                      │
│                                                                 │
│  Why: Maximum synergy with BRI's @diff package                  │
│       Minimal code changes to index.js                          │
│       Single event log = storage + pub/sub + audit              │
│       Old values in tuples = instant undo/reversal              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PHASE 2 (Scale-out, multi-node):                               │
│  ─────────────────────────────────                              │
│  Architecture: 4 (Actor-Based)                                  │
│  Store: Append-Only Log per shard                               │
│  Language: TypeScript + Rust for hot paths                      │
│                                                                 │
│  Why: Natural partitioning by type prefix                       │
│       Each shard's log can be replicated independently          │
│       Actor supervision handles failures gracefully             │
│       @diff's array paths enable efficient sharding             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture Updates Based on Roadmap Features

After reviewing [roadmap.md](roadmap.md), several planned features have significant architectural implications:

### Feature Impact Analysis

| Roadmap Feature | Architecture Impact | Store Impact |
|-----------------|---------------------|--------------|
| **Transaction System (PREP/DUMP/PUSH)** | Requires atomic commit/rollback | Event log naturally supports this |
| **Graph Relationships (LINK/REFS)** | Need edge storage + graph index | Separate edge log or inline edges |
| **FIND/WALK Traversal** | Need efficient graph traversal | Graph index in memory |
| **Memoization Cache** | Add cache layer | Cache keyed by `$ID + updatedAt` |
| **Two-Part Storage Model** | Split base data from relationships | Two event streams or merged |

---

### Transaction System + Event Log: Perfect Match

The roadmap's PREP/DUMP/PUSH transaction system maps perfectly to the append-only log:

```
┌─────────────────────────────────────────────────────────────────┐
│          TRANSACTION FLOW WITH EVENT LOG                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  db.PREP(() => {                                                │
│    return Promise.all([                                         │
│      db.add.user({ name: "Alice" }),                           │
│      db.add.userbio({ ... })                                   │
│    ])                                                           │
│  })                                                             │
│                                                                 │
│  IMPLEMENTATION:                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  PREP: Start transaction                                 │   │
│  │  ├─ Generate transaction ID (txn_abc123)                 │   │
│  │  ├─ Create in-memory staging area                        │   │
│  │  └─ Start timeout timer (1000ms)                         │   │
│  │                                                          │   │
│  │  During transaction:                                     │   │
│  │  ├─ All writes go to staging (NOT to log yet)            │   │
│  │  ├─ Reads check staging first, then main store           │   │
│  │  └─ MORE() resets timeout timer                          │   │
│  │                                                          │   │
│  │  PUSH (commit):                                          │   │
│  │  ├─ Write all staged events to log atomically            │   │
│  │  │   ┌─────────────────────────────────────────┐        │   │
│  │  │   │ { txn: "txn_abc123", type: "BEGIN" }    │        │   │
│  │  │   │ { txn: "txn_abc123", ...event1... }     │        │   │
│  │  │   │ { txn: "txn_abc123", ...event2... }     │        │   │
│  │  │   │ { txn: "txn_abc123", type: "COMMIT" }   │        │   │
│  │  │   └─────────────────────────────────────────┘        │   │
│  │  ├─ Apply to in-memory state                             │   │
│  │  └─ Clear staging area                                   │   │
│  │                                                          │   │
│  │  DUMP (rollback):                                        │   │
│  │  ├─ Discard staging area (nothing written to log!)       │   │
│  │  ├─ Run optional cleanup function                        │   │
│  │  └─ Jump to finally                                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  CRASH RECOVERY:                                                │
│  ├─ If log has BEGIN but no COMMIT → ignore transaction        │
│  ├─ If log has BEGIN and COMMIT → replay all events in txn     │
│  └─ Incomplete transactions are automatically rolled back!     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**TypeScript Implementation:**

```typescript
interface TransactionContext {
  id: string;
  staging: LogEntry[];
  timeout: NodeJS.Timeout;
  startTime: number;
}

class EventSourcedStore {
  private activeTransactions: Map<string, TransactionContext> = new Map();
  private defaultTimeout = 1000; // ms

  // Start transaction
  PREP<T>(fn: () => Promise<T>): TransactionPromise<T> {
    const txnId = `txn_${generateId()}`;
    const ctx: TransactionContext = {
      id: txnId,
      staging: [],
      timeout: setTimeout(() => this.autoRollback(txnId), this.defaultTimeout),
      startTime: Date.now()
    };

    this.activeTransactions.set(txnId, ctx);

    // Execute with transaction context
    return new TransactionPromise(
      fn().then(result => ({ txnId, result })),
      this
    );
  }

  // Commit transaction
  async PUSH(txnId: string): Promise<void> {
    const ctx = this.activeTransactions.get(txnId);
    if (!ctx) throw new Error('Transaction not found');

    clearTimeout(ctx.timeout);

    // Write BEGIN marker
    await this.log.append({ type: 'TXN_BEGIN', txn: txnId, timestamp: new Date() });

    // Write all staged events
    for (const entry of ctx.staging) {
      await this.log.append({ ...entry, txn: txnId });
    }

    // Write COMMIT marker
    await this.log.append({ type: 'TXN_COMMIT', txn: txnId, timestamp: new Date() });

    // Apply to in-memory state
    for (const entry of ctx.staging) {
      this.applyEntry(entry);
    }

    this.activeTransactions.delete(txnId);
  }

  // Rollback transaction
  DUMP(txnId: string, cleanup?: () => void): void {
    const ctx = this.activeTransactions.get(txnId);
    if (!ctx) return;

    clearTimeout(ctx.timeout);
    this.activeTransactions.delete(txnId);

    // Nothing written to log - just discard staging
    if (cleanup) cleanup();
  }

  // Reset timeout
  MORE(txnId: string): void {
    const ctx = this.activeTransactions.get(txnId);
    if (!ctx) return;

    clearTimeout(ctx.timeout);
    ctx.timeout = setTimeout(
      () => this.autoRollback(txnId),
      this.defaultTimeout
    );
  }

  // Write within transaction
  async setInTransaction(txnId: string, key: string, value: string): Promise<void> {
    const ctx = this.activeTransactions.get(txnId);
    if (!ctx) throw new Error('No active transaction');

    const entry = this.createLogEntry(key, value);
    ctx.staging.push(entry); // Stage, don't write yet
  }
}
```

---

### Graph Relationships + Event Log

The roadmap describes LINK/REFS for bidirectional and one-way relationships. These map to events:

```
┌─────────────────────────────────────────────────────────────────┐
│          GRAPH OPERATIONS AS EVENTS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  alice.LINK.friends(bob)                                        │
│  ─────────────────────────                                      │
│  Generates TWO events (bidirectional):                          │
│                                                                 │
│  Event 1: {                                                     │
│    action: "LINK",                                              │
│    target: "USER_alice",                                        │
│    patches: [                                                   │
│      { op: "add", path: "/friends/-", value: "USER_bob" }       │
│    ],                                                           │
│    edge: { type: "friends", from: "USER_alice", to: "USER_bob" }│
│  }                                                              │
│                                                                 │
│  Event 2: {                                                     │
│    action: "LINK",                                              │
│    target: "USER_bob",                                          │
│    patches: [                                                   │
│      { op: "add", path: "/friends/-", value: "USER_alice" }     │
│    ],                                                           │
│    edge: { type: "friends", from: "USER_bob", to: "USER_alice" }│
│  }                                                              │
│                                                                 │
│  alice.REFS.watchedS(matrix)                                    │
│  ────────────────────────────                                   │
│  Generates ONE event (one-way):                                 │
│                                                                 │
│  Event: {                                                       │
│    action: "REFS",                                              │
│    target: "USER_alice",                                        │
│    patches: [                                                   │
│      { op: "add", path: "/watched/-", value: "VIDS_matrix" }    │
│    ],                                                           │
│    edge: { type: "watched", from: "USER_alice", to: "VIDS_matrix" }│
│  }                                                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Graph Index for FIND/WALK Traversal:**

```typescript
// Built from events during replay
interface GraphIndex {
  // Forward edges: from → [to1, to2, ...]
  forward: Map<string, Map<string, Set<string>>>;  // type → fromId → toIds

  // Reverse edges: to → [from1, from2, ...]
  reverse: Map<string, Map<string, Set<string>>>;  // type → toId → fromIds

  // Edge metadata
  metadata: Map<string, EdgeMeta>;  // "fromId:type:toId" → metadata
}

class GraphStore {
  private index: GraphIndex = {
    forward: new Map(),
    reverse: new Map(),
    metadata: new Map()
  };

  // Rebuild index from event log
  private replayEdgeEvent(entry: LogEntry): void {
    if (!entry.edge) return;

    const { type, from, to, meta } = entry.edge;

    // Add to forward index
    if (!this.index.forward.has(type)) {
      this.index.forward.set(type, new Map());
    }
    const fwd = this.index.forward.get(type)!;
    if (!fwd.has(from)) fwd.set(from, new Set());
    fwd.get(from)!.add(to);

    // Add to reverse index (for LINK, not REFS)
    if (entry.action === 'LINK') {
      if (!this.index.reverse.has(type)) {
        this.index.reverse.set(type, new Map());
      }
      const rev = this.index.reverse.get(type)!;
      if (!rev.has(to)) rev.set(to, new Set());
      rev.get(to)!.add(from);
    }

    // Store metadata
    if (meta) {
      this.index.metadata.set(`${from}:${type}:${to}`, meta);
    }
  }

  // FIND traversal: alice.FIND.friends.children.watched(bluey)
  async find(start: string, path: string[], target?: string): Promise<[object[], EdgeMeta[][]]> {
    let currentNodes = new Set([start]);
    const metaPerHop: EdgeMeta[][] = [];

    for (const edgeType of path) {
      const nextNodes = new Set<string>();
      const hopMeta: EdgeMeta[] = [];

      for (const nodeId of currentNodes) {
        const edges = this.index.forward.get(edgeType)?.get(nodeId) || new Set();
        for (const toId of edges) {
          if (!target || toId === target || path.indexOf(edgeType) < path.length - 1) {
            nextNodes.add(toId);
            const meta = this.index.metadata.get(`${nodeId}:${edgeType}:${toId}`);
            if (meta) hopMeta.push(meta);
          }
        }
      }

      currentNodes = nextNodes;
      metaPerHop.push(hopMeta);
    }

    // Fetch full documents for result nodes
    const results = await Promise.all(
      [...currentNodes].map(id => this.get(id))
    );

    return [results.filter(Boolean), metaPerHop];
  }

  // WALK: shortest path between two nodes
  async walk(from: string, to: string): Promise<[string[], EdgeMeta[]]> {
    // BFS for shortest path
    const visited = new Set<string>();
    const queue: { node: string; path: string[]; meta: EdgeMeta[] }[] = [
      { node: from, path: [from], meta: [] }
    ];

    while (queue.length > 0) {
      const { node, path, meta } = queue.shift()!;

      if (node === to) {
        return [path, meta];
      }

      if (visited.has(node)) continue;
      visited.add(node);

      // Check all edge types from this node
      for (const [edgeType, edges] of this.index.forward) {
        const neighbors = edges.get(node) || new Set();
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            const edgeMeta = this.index.metadata.get(`${node}:${edgeType}:${neighbor}`);
            queue.push({
              node: neighbor,
              path: [...path, neighbor],
              meta: [...meta, edgeMeta].filter(Boolean) as EdgeMeta[]
            });
          }
        }
      }
    }

    return [[], []]; // No path found
  }
}
```

---

### Two-Part Storage Model

The roadmap describes storing records as `[baseData, relationships]`:

```
┌─────────────────────────────────────────────────────────────────┐
│          TWO-PART STORAGE WITH EVENT LOG                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OPTION 1: Single log, tagged entries                           │
│  ────────────────────────────────────────                       │
│  { target: "USER_alice", dataType: "base", patches: [...] }     │
│  { target: "USER_alice", dataType: "edges", patches: [...] }    │
│                                                                 │
│  Pro: Simple, single file                                       │
│  Con: Must filter when rebuilding                               │
│                                                                 │
│  OPTION 2: Two separate logs (RECOMMENDED)                      │
│  ─────────────────────────────────────────                      │
│  data/                                                          │
│  ├── entities.log    (base data events)                        │
│  ├── edges.log       (relationship events)                     │
│  ├── entities.snapshot                                         │
│  └── edges.snapshot                                            │
│                                                                 │
│  Pro: Independent snapshots, parallel replay                    │
│  Pro: Edge log can be optimized differently                     │
│  Con: Two files to manage                                       │
│                                                                 │
│  IN-MEMORY STRUCTURE:                                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  documents: Map<$ID, { base: object, edges: object }>    │   │
│  │                                                          │   │
│  │  "USER_alice": {                                         │   │
│  │    base: { name: "Alice", email: "..." },               │   │
│  │    edges: { friends: ["USER_bob"], watched: ["..."] }    │   │
│  │  }                                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  API unchanged - BRI merges base+edges when returning:          │
│  db.get.user("USER_alice")                                      │
│  // Returns: { name: "Alice", friends: ["USER_bob"], ... }      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Memoization Cache Integration

The roadmap's memoization strategy (`$ID + updatedAt` as cache key) fits perfectly:

```typescript
class CachedStore {
  private store: EventSourcedStore;
  private cache: Map<string, { serialized: string; updatedAt: Date }> = new Map();

  async get(key: string): Promise<string | null> {
    const doc = await this.store.getDocument(key);
    if (!doc) return null;

    const cacheKey = `${key}:${doc.updatedAt.getTime()}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return cached.serialized; // Cache hit!
    }

    // Cache miss - serialize and store
    const serialized = JSS.stringify(doc);
    this.cache.set(cacheKey, { serialized, updatedAt: doc.updatedAt });

    // Cleanup old versions of this key
    for (const [k] of this.cache) {
      if (k.startsWith(`${key}:`) && k !== cacheKey) {
        this.cache.delete(k);
      }
    }

    return serialized;
  }
}
```

---

### Updated Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                  UPDATED ARCHITECTURE                           │
│          (Supporting All Roadmap Features)                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 BRI Engine (index.js)                    │   │
│  │  ┌───────────────────────────────────────────────────┐  │   │
│  │  │  Public API:                                       │  │   │
│  │  │  db.add / db.get / db.set / db.del / db.sub       │  │   │
│  │  │  db.PREP / db.DUMP / db.PUSH / db.MORE            │  │   │
│  │  │  obj.LINK / obj.REFS / obj.FIND / obj.WALK        │  │   │
│  │  └───────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Storage Adapter Interface                   │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │  // Core operations                              │    │   │
│  │  │  set(key, value): Promise<void>                  │    │   │
│  │  │  get(key): Promise<string | null>                │    │   │
│  │  │                                                  │    │   │
│  │  │  // Transactions                                 │    │   │
│  │  │  beginTxn(): string                              │    │   │
│  │  │  commitTxn(txnId): Promise<void>                 │    │   │
│  │  │  rollbackTxn(txnId): void                        │    │   │
│  │  │                                                  │    │   │
│  │  │  // Graph operations                             │    │   │
│  │  │  addEdge(from, to, type, meta?): Promise<void>   │    │   │
│  │  │  removeEdge(from, to, type): Promise<void>       │    │   │
│  │  │  traverse(start, path, target?): Promise<...>    │    │   │
│  │  │  shortestPath(from, to): Promise<...>            │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           Event-Sourced Store (Phase 1)                  │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │                                                         │   │
│  │  ┌─────────────────┐  ┌─────────────────┐              │   │
│  │  │  Memoization    │  │  Transaction    │              │   │
│  │  │  Cache          │  │  Manager        │              │   │
│  │  │  ($ID+updatedAt)│  │  (staging area) │              │   │
│  │  └─────────────────┘  └─────────────────┘              │   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │              In-Memory State                     │   │   │
│  │  │  ┌──────────────────┐  ┌──────────────────┐    │   │   │
│  │  │  │ Documents        │  │ Graph Index      │    │   │   │
│  │  │  │ Map<$ID, {       │  │ forward edges    │    │   │   │
│  │  │  │   base: {...},   │  │ reverse edges    │    │   │   │
│  │  │  │   edges: {...}   │  │ edge metadata    │    │   │   │
│  │  │  │ }>               │  │                  │    │   │   │
│  │  │  └──────────────────┘  └──────────────────┘    │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                              │                          │   │
│  │                              │ rebuild via applyChanges()│   │
│  │                              │                          │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │           Append-Only Event Logs                 │   │   │
│  │  │  ┌───────────────┐  ┌───────────────┐           │   │   │
│  │  │  │ entities.log  │  │ edges.log     │           │   │   │
│  │  │  │ (base data)   │  │ (LINK/REFS)   │           │   │   │
│  │  │  └───────────────┘  └───────────────┘           │   │   │
│  │  │                                                  │   │   │
│  │  │  Transaction markers: TXN_BEGIN, TXN_COMMIT     │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                              │                          │   │
│  │                              │ periodic                 │   │
│  │                              ▼                          │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │              Snapshots                           │   │   │
│  │  │  entities.snapshot + edges.snapshot              │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │         EventEmitter (Pub/Sub)                   │   │   │
│  │  │  Log entries broadcast to subscribers            │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Implementation Priority (Updated)

Based on roadmap alignment:

```
┌─────────────────────────────────────────────────────────────────┐
│              IMPLEMENTATION PRIORITY (UPDATED)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PHASE 1A: Core Store (enables everything else)                 │
│  ───────────────────────────────────────────────                │
│  1. [ ] StorageAdapter interface (TypeScript)                   │
│  2. [ ] Append-only event log (entities.log)                    │
│  3. [ ] In-memory state with Map<$ID, Document>                 │
│  4. [ ] Snapshot creation and recovery                          │
│  5. [ ] EventEmitter for pub/sub                                │
│                                                                 │
│  PHASE 1B: Transaction System (roadmap priority #1)             │
│  ─────────────────────────────────────────────────              │
│  6. [ ] Transaction staging area                                │
│  7. [ ] PREP/PUSH/DUMP/MORE implementation                      │
│  8. [ ] TXN_BEGIN/TXN_COMMIT markers in log                     │
│  9. [ ] Timeout handling with auto-rollback                     │
│                                                                 │
│  PHASE 1C: Graph Relationships (roadmap priority #2)            │
│  ─────────────────────────────────────────────────              │
│  10. [ ] Separate edges.log for relationships                   │
│  11. [ ] LINK (bidirectional) implementation                    │
│  12. [ ] REFS (one-way) implementation                          │
│  13. [ ] Graph index (forward + reverse edges)                  │
│  14. [ ] Edge metadata storage                                  │
│                                                                 │
│  PHASE 1D: Memoization (roadmap priority #3)                    │
│  ─────────────────────────────────────────────                  │
│  15. [ ] Cache layer with $ID+updatedAt keys                    │
│  16. [ ] Auto-invalidation on update                            │
│                                                                 │
│  PHASE 1E: Graph Traversal (roadmap priority #4)                │
│  ────────────────────────────────────────────────               │
│  17. [ ] FIND path traversal                                    │
│  18. [ ] WALK shortest path (BFS)                               │
│  19. [ ] Metadata per hop in results                            │
│                                                                 │
│  PHASE 2: Scale-out (when needed)                               │
│  ────────────────────────────────                               │
│  20. [ ] Actor-based sharding by type prefix                    │
│  21. [ ] Per-shard event logs                                   │
│  22. [ ] Distributed transactions                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Time-Travel and Undo (Bonus Feature)

With @diff's tuple-based storage, BRI gains time-travel capabilities for free:

```typescript
import { applyChanges, type Change } from '@diff';

// Reconstruct document at any point in time
async getAtTime(key: string, timestamp: Date): Promise<object> {
  let doc = {};

  for await (const entry of this.log.readAll()) {
    if (entry.target !== key) continue;
    if (entry.timestamp > timestamp) break;

    const overlay = applyChanges(entry.changes, doc);
    Object.assign(doc, overlay);
  }

  return doc;
}

// Undo last N changes to a document - INSTANT with @diff!
async undo(key: string, count: number): Promise<object> {
  const entries = await this.log.getEntriesFor(key);
  const toUndo = entries.slice(-count);

  // @diff tuples include old values - just swap them!
  for (const entry of toUndo.reverse()) {
    const reversed: Change[] = entry.changes.map(
      ([path, newVal, oldVal]) => [path, oldVal, newVal]
    );
    const overlay = applyChanges(reversed, {});
    // Apply to current document...
  }
}

// Get full history of a document
async getHistory(key: string): Promise<LogEntry[]> {
  return this.log.getEntriesFor(key);
}

// BONUS: @diff makes reversal trivial - no inverse computation needed!
function reverseChanges(changes: Change[]): Change[] {
  return changes.map(([path, newVal, oldVal]) => [path, oldVal, newVal]);
}
```

---

## Language Proposals

### Language 1: TypeScript (Recommended for Phase 1)

**Description:** Rewrite/enhance the store layer in TypeScript for type safety while maintaining Node.js compatibility.

```typescript
interface StorageAdapter {
  // Key-Value operations
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  rename(oldKey: string, newKey: string): Promise<void>;

  // Set operations
  sAdd(set: string, member: string): Promise<void>;
  sMembers(set: string): Promise<string[]>;
  sRem(set: string, member: string): Promise<void>;

  // Pub/Sub
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, callback: (msg: string) => void): () => void;

  // Lifecycle
  connect(): Promise<void>;
  close(): Promise<void>;
}

class BinaryFileStore implements StorageAdapter {
  private index: Map<string, { offset: number; length: number }>;
  private collections: Map<string, Set<string>>;
  private fd: number;
  // ...implementation
}
```

| Pros | Cons |
|------|------|
| Minimal migration from current JS | Still single-threaded |
| Type safety catches bugs early | No true parallelism |
| Same ecosystem (npm, node_modules) | Memory-bound by V8 heap |
| Excellent IDE support | GC pauses on large heaps |
| Team already knows JS/TS | File I/O is async but CPU-bound JSON is not |

**Future Benefits:**
- Gradual adoption (can mix .js and .ts)
- Better refactoring support
- Self-documenting interfaces
- Can share types with BRI engine

---

### Language 2: AssemblyScript (WebAssembly)

**Description:** TypeScript-like syntax compiled to WebAssembly for near-native performance within Node.js.

```typescript
// AssemblyScript syntax (subset of TypeScript)
@json
class Document {
  $ID: string = "";
  data: string = "";  // JSON string
  createdAt: i64 = 0;
}

export function serialize(doc: Document): ArrayBuffer {
  return String.UTF8.encode(JSON.stringify(doc));
}

export function get(key: string): Document | null {
  const offset = index.get(key);
  if (offset < 0) return null;
  return readFromOffset(offset);
}
```

| Pros | Cons |
|------|------|
| Near-native performance | Limited standard library |
| Runs in Node.js via WASM | No direct file system access |
| Familiar TS-like syntax | Must call back to JS for I/O |
| Portable binary | Debugging is harder |
| Sandboxed execution | Still maturing ecosystem |

**Future Benefits:**
- Can run in browsers (for offline/sync)
- Cloudflare Workers, Fastly Compute compatible
- Deterministic memory (no GC pauses)
- Future-proof for edge computing

---

### Language 3: Rust (via napi-rs)

**Description:** High-performance native module written in Rust, exposed to Node.js via N-API bindings.

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

#[napi]
pub struct BriStore {
    documents: RwLock<HashMap<String, String>>,
    collections: RwLock<HashMap<String, HashSet<String>>>,
    file_path: String,
}

#[napi]
impl BriStore {
    #[napi(constructor)]
    pub fn new(path: String) -> Self {
        BriStore {
            documents: RwLock::new(HashMap::new()),
            collections: RwLock::new(HashMap::new()),
            file_path: path,
        }
    }

    #[napi]
    pub async fn get(&self, key: String) -> Option<String> {
        self.documents.read().unwrap().get(&key).cloned()
    }

    #[napi]
    pub async fn set(&self, key: String, value: String) -> Result<()> {
        self.documents.write().unwrap().insert(key, value);
        self.persist().await
    }
}
```

| Pros | Cons |
|------|------|
| Best-in-class performance | Steep learning curve |
| Memory safety without GC | Longer development time |
| True multi-threading | Native compilation per platform |
| Battle-tested for DBs | Smaller talent pool |
| Can use existing crates | Build complexity (cargo + npm) |

**Future Benefits:**
- Can leverage sled, rocksdb crates
- Excellent for CPU-intensive operations
- Growing in popularity (Deno, SWC, Turbopack)
- Can compile to WASM too

---

### Language 4: Go (via CGO or subprocess)

**Description:** Standalone Go binary that BRI communicates with via IPC, Unix socket, or embedded via CGO.

```go
package main

import (
    "encoding/json"
    "sync"
)

type Store struct {
    documents   map[string]string
    collections map[string]map[string]struct{}
    mu          sync.RWMutex
    pubsub      *PubSub
}

func (s *Store) Set(key, value string) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.documents[key] = value
    return s.persist()
}

func (s *Store) Get(key string) (string, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    val, ok := s.documents[key]
    return val, ok
}

// Main entry point for subprocess mode
func main() {
    store := NewStore("./data")
    startJSONRPCServer(store, "/tmp/bri.sock")
}
```

| Pros | Cons |
|------|------|
| Simple, readable code | IPC overhead if subprocess |
| Fast compilation | CGO is complex |
| Excellent concurrency | No native Node.js interop |
| Single binary deployment | Separate process to manage |
| Large ecosystem | Two runtimes to maintain |

**Future Benefits:**
- Easy to build CLI tools around it
- Natural microservice architecture
- Excellent for standalone server mode
- Can scale independently

---

## Comparison Matrix

### Architecture Comparison

| Criteria | Single-File Embedded | Hybrid WAL | LSM-Tree | Actor-Based |
|----------|---------------------|------------|----------|-------------|
| Complexity | Low | Medium | High | High |
| Write Performance | Medium | High | Very High | Medium |
| Read Performance | High | Very High | Medium | Medium |
| Durability | Medium | High | High | Depends |
| Memory Usage | High | Medium | Low | Medium |
| Implementation Time | 1-2 weeks | 2-4 weeks | 4-8 weeks | 3-5 weeks |

### Store Comparison

| Criteria | JSON Files | Binary File | Append-Only Log |
|----------|------------|-------------|-----------------|
| Simplicity | Very High | Medium | Medium |
| Performance | Low | High | High |
| Debuggability | Very High | Low | Medium |
| Disk Efficiency | Low | High | Medium |
| Scalability | Low | High | High |
| Implementation Time | 3-5 days | 1-2 weeks | 1-2 weeks |

### Language Comparison

| Criteria | TypeScript | AssemblyScript | Rust | Go |
|----------|------------|----------------|------|-----|
| Performance | Medium | High | Very High | High |
| Dev Speed | Very High | Medium | Low | High |
| Node.js Integration | Native | Via WASM | Via napi-rs | Via IPC |
| Learning Curve | None | Low | High | Low |
| Ecosystem | Very Large | Small | Large | Large |
| Implementation Time | Baseline | +50% | +100% | +75% |

---

## Recommended Implementation Path

### Phase 1: TypeScript + Binary File Store (Recommended Start)

```
┌─────────────────────────────────────────────────────────────┐
│                    BRI Engine (index.js)                    │
│                        (unchanged)                          │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│              StorageAdapter Interface (TS)                  │
└───────────────────────┬─────────────────────────────────────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
┌───────────────┐ ┌───────────┐ ┌───────────────┐
│ RedisAdapter  │ │ FileStore │ │ MemoryStore   │
│ (backwards    │ │ (new)     │ │ (for tests)   │
│  compat)      │ │           │ │               │
└───────────────┘ └───────────┘ └───────────────┘
```

**Why this combination:**
1. **TypeScript** - Minimal learning curve, same ecosystem
2. **Binary File Store** - Best balance of performance and simplicity
3. **Adapter Pattern** - Allows keeping Redis as fallback
4. **In-Memory for tests** - Fast test suite

### Phase 2: Performance Optimization

- Add WAL for crash safety
- Consider Rust rewrite of hot paths
- Implement proper compaction

### Phase 3: Scale Features

- Add replication support
- Consider distributed pub/sub
- Evaluate Go subprocess for clustering

---

## Next Steps

1. [ ] Create `StorageAdapter` TypeScript interface
2. [ ] Implement `MemoryStore` for testing
3. [ ] Implement `BinaryFileStore` with basic persistence
4. [ ] Implement `EventEmitter`-based pub/sub
5. [ ] Create `RedisAdapter` wrapper (backward compatibility)
6. [ ] Modify [index.js](index.js) to accept adapter injection
7. [ ] Write comprehensive test suite
8. [ ] Benchmark against Redis baseline
9. [ ] Document migration guide

---

## File Structure (Proposed)

```
BRI/
├── index.js                 (BRI engine - unchanged API)
├── src/
│   ├── adapters/
│   │   ├── interface.ts     (StorageAdapter interface)
│   │   ├── redis.ts         (RedisAdapter - backward compat)
│   │   ├── memory.ts        (MemoryStore - for tests)
│   │   └── file.ts          (BinaryFileStore - new default)
│   ├── pubsub/
│   │   └── emitter.ts       (EventEmitter-based pub/sub)
│   └── utils/
│       └── binary.ts        (Binary file format helpers)
├── test/
│   ├── adapters.test.ts
│   └── integration.test.ts
└── data/                    (runtime data directory)
    ├── wal/                 (Write-Ahead Log - permanent history)
    │   ├── snap_*.wal       (archived segments matching snapshots)
    │   └── 000000.wal       (current active segment)
    ├── snapshots/           (optional fast-load optimization)
    │   └── snap_*.json
    └── cold/                (evicted items from memory)
        ├── POST/
        │   └── {id}.jss
        ├── USER/
        │   └── {id}.jss
        └── {TYPE}/
            └── {id}.jss
```

---

## Memory-First Architecture

### Design Philosophy

**ALL working data lives in memory.** This is an ephemeral resource store. The disk is used for:
1. **WAL** - Permanent history log (never deleted, enables full recovery/rollback)
2. **Snapshot** - Single file for fast startup (replaced every 30min interval)
3. **Cold storage** - ONLY when memory exceeds `maxMemoryMB` threshold

### Memory Target

- **Default: 80% memory utilization target (`evictionThreshold: 0.8`)**
- Eviction ONLY triggers when memory exceeds `maxMemoryMB * evictionThreshold`
- Algorithm detects low-access or old/stale data for eviction candidates
- **Sets live in memory only** - no cold storage for sets

### Data Directory Structure

```
data/
├── wal/                     # Write-Ahead Log (PERMANENT)
│   ├── 000000.wal           # First WAL segment
│   ├── 000001.wal           # Created after snapshot
│   └── 000002.wal           # And so on...
├── snapshot.jss             # Single snapshot file (replaced every 30min)
└── cold/                    # Evicted documents ONLY (no sets)
    ├── POST/
    │   └── fu352dp.jss
    └── USER/
        └── a8x9k2m.jss
```

**Important:**
- No `/data/docs`, `/data/sets`, or `/data/snapshots/` directories
- Cold storage is ONLY for documents evicted due to memory pressure
- Sets are always in-memory (small, frequently accessed)

### Cold Storage - Promise-Based Eviction

When memory exceeds threshold, least-recently-used items are evicted:

1. Item serialized to `/data/cold/{TYPE}/{id}.jss`
2. **Memory slot replaced with a Promise** (not deleted)
3. On access, Promise triggers load from cold storage
4. Once loaded, Promise resolves to the value, item returns to hot tier
5. Cold file is deleted after successful load

```javascript
// Eviction flow
async evict(key, value) {
  await this.coldTier.writeDoc(key, value);

  // Replace value with promise that loads from cold
  const loadPromise = this.createColdLoader(key);
  this.documents.set(key, { promise: loadPromise });
}

// Access flow
async get(key) {
  const entry = this.documents.get(key);

  if (entry?.promise) {
    // Cold reference - load and promote
    const value = await entry.promise;
    this.documents.set(key, { data: value });
    await this.coldTier.deleteDoc(key);
    return value;
  }

  return entry?.data;
}
```

### Snapshot Behavior

- **Single file:** `/data/snapshot.jss`
- **Interval:** Every 30 minutes (configurable)
- **On snapshot:**
  1. Replace `/data/snapshot.jss` with current state
  2. Create new WAL segment (rotate WAL)
  3. Old WAL segments preserved for full history

### Recovery Options

1. **Fast startup:** Load `/data/snapshot.jss` + replay WAL segments after snapshot's walLine
2. **Full rebuild:** Replay ALL WAL files in order (ignore snapshot)
3. **Point-in-time rollback:** Replay WAL files up to desired line number

### WAL Format

Each line: `{timestamp}|{pointer}|{entry}`

- **timestamp:** Unix ms when written
- **pointer:** `hash(prevPointer || "", entry)` - chain integrity (8 chars sha256)
- **entry:** JSS-encoded operation

Example:
```
1768407028863|b1fe4827|{"action":"SET","target":"USER_77fhtpc","value":{...}}
```

Line position IS the sequence number (no separate LSN needed)
