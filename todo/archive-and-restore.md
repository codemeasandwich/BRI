# Archive & Restore: WAL Archival with Compression, Error Correction, and Recovery

## Overview

A comprehensive archival and restoration system that packages WAL files with compression, checksums, and error correction for long-term storage and disaster recovery. Each archive is self-contained with a starting snapshot, enabling point-in-time recovery. The restore mechanism pulls archives from remote or local storage and reconstructs the database state.

## Use Cases

### Archival
1. **Disaster Recovery**: Create recoverable backups for catastrophic failure scenarios
2. **Compliance**: Long-term data retention for regulatory requirements
3. **Storage Optimization**: Move old WAL files to cheaper storage tiers
4. **Audit Trail**: Immutable record of all database changes
5. **Geographic Redundancy**: Replicate archives to multiple regions

### Restoration
1. **Disaster Recovery**: Restore after complete data loss
2. **Point-in-Time Recovery**: Restore to a specific timestamp
3. **Database Cloning**: Create test/dev environments from production archives
4. **Migration**: Move databases between servers/clouds
5. **Rollback**: Undo problematic changes by restoring previous state

## Current State

BRI currently:
- Creates WAL segments that grow up to 10MB each
- Calls `wal.archive()` to rotate segments after snapshots
- Keeps all WAL segments indefinitely (no cleanup)
- Has no compression or remote archival capability
- Cannot restore from archived WAL files
- Supports only local snapshot + WAL recovery on startup

---

# PART 1: ARCHIVE SYSTEM

## Archive Architecture

### 1. Archive Package Structure

Each archive is a self-contained package:

```
archive-2024-01-15T10-30-00.bri.zst
├── manifest.jss               # Archive metadata
├── snapshot.jss.zst           # Compressed starting snapshot
├── wal/
│   ├── 000000.wal.zst         # Compressed WAL segments
│   ├── 000001.wal.zst
│   └── 000002.wal.zst
├── checksums.sha256           # File checksums
└── recovery.par2              # Parity data for error correction
```

### 2. Archive Manifest

```javascript
{
  version: "1.0",
  archiveId: "arc_2024-01-15T10-30-00-abc123",
  instanceId: "bri-prod-01",

  // Time range covered
  timeRange: {
    start: "2024-01-14T10:30:00.000Z",  // Snapshot timestamp
    end: "2024-01-15T10:30:00.000Z",    // Last WAL entry
    walLines: { start: 0, end: 15234 }
  },

  // Contents
  contents: {
    snapshotFile: "snapshot.jss.zst",
    snapshotWalLine: 0,                  // WAL line at snapshot time
    walSegments: [
      { file: "wal/000000.wal.zst", lines: { start: 1, end: 5000 } },
      { file: "wal/000001.wal.zst", lines: { start: 5001, end: 10000 } },
      { file: "wal/000002.wal.zst", lines: { start: 10001, end: 15234 } }
    ],
    totalWalEntries: 15234
  },

  // Compression
  compression: {
    algorithm: "zstd",
    level: 19,                           // Max compression
    originalSize: 52428800,              // 50MB uncompressed
    compressedSize: 8388608              // 8MB compressed
  },

  // Integrity
  integrity: {
    checksumAlgorithm: "sha256",
    archiveChecksum: "sha256:abc123...",
    fileChecksums: {
      "snapshot.jss.zst": "sha256:def456...",
      "wal/000000.wal.zst": "sha256:ghi789..."
    }
  },

  // Error correction
  errorCorrection: {
    enabled: true,
    algorithm: "par2",
    recoveryBlocks: 10,                  // 10% redundancy
    parityFile: "recovery.par2"
  },

  // Statistics
  stats: {
    documentsAtSnapshot: 1523,
    operationsInWal: 15234,
    byOperation: { SET: 10000, DELETE: 3000, RENAME: 2000, SADD: 200, SREM: 34 }
  },

  // Metadata
  createdAt: "2024-01-15T10:30:05.000Z",
  createdBy: "archive-scheduler",
  retentionUntil: "2025-01-15T10:30:00.000Z"
}
```

### 3. Archive Triggers

Archives can be triggered by:

```javascript
{
  archive: {
    // Time-based
    intervalMs: 86400000,              // Every 24 hours
    schedule: "0 2 * * *",             // Cron: 2 AM daily

    // Size-based
    walSizeMB: 100,                     // When WAL exceeds 100MB

    // Count-based
    walSegments: 10,                    // After 10 WAL segments
    walEntries: 100000,                 // After 100K entries

    // Manual
    manual: true                        // API/CLI triggered
  }
}
```

### 4. Archive Manager

**File**: `archive/manager.js`

```javascript
export class ArchiveManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.archiveDir = options.archiveDir || path.join(this.dataDir, 'archives');
    this.tempDir = options.tempDir || path.join(this.dataDir, 'archive-tmp');

    // Compression settings
    this.compression = {
      algorithm: options.compression?.algorithm || 'zstd',
      level: options.compression?.level || 19
    };

    // Error correction
    this.errorCorrection = {
      enabled: options.errorCorrection?.enabled !== false,
      redundancy: options.errorCorrection?.redundancy || 0.1  // 10%
    };

    // Remote storage
    this.remote = options.remote || null;  // S3, GCS, Azure, etc.

    // Scheduling
    this.scheduler = null;
  }

  // Create archive from current state
  async createArchive(options = {}) {
    const archiveId = this.generateArchiveId();
    const workDir = path.join(this.tempDir, archiveId);

    try {
      await fs.mkdir(workDir, { recursive: true });

      // 1. Create snapshot for archive starting point
      const snapshot = await this.createArchiveSnapshot(workDir);

      // 2. Collect WAL segments since last archive
      const walSegments = await this.collectWalSegments(options.sinceArchive);

      // 3. Compress files
      await this.compressFiles(workDir, snapshot, walSegments);

      // 4. Generate checksums
      const checksums = await this.generateChecksums(workDir);

      // 5. Generate error correction data
      if (this.errorCorrection.enabled) {
        await this.generateParityData(workDir);
      }

      // 6. Create manifest
      const manifest = await this.createManifest(workDir, {
        archiveId,
        snapshot,
        walSegments,
        checksums
      });

      // 7. Package archive
      const archivePath = await this.packageArchive(workDir, archiveId);

      // 8. Upload to remote (if configured)
      if (this.remote) {
        await this.uploadToRemote(archivePath);
      }

      // 9. Cleanup old WAL segments
      if (options.cleanupWal !== false) {
        await this.cleanupArchivedWal(walSegments);
      }

      return {
        archiveId,
        path: archivePath,
        manifest
      };

    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // Verify archive integrity
  async verifyArchive(archivePath) {
    const workDir = await this.extractArchive(archivePath);

    try {
      // 1. Verify checksums
      const checksumResult = await this.verifyChecksums(workDir);

      // 2. Verify error correction data
      const parityResult = await this.verifyParityData(workDir);

      // 3. Verify WAL chain integrity
      const walResult = await this.verifyWalChain(workDir);

      // 4. Verify snapshot loadable
      const snapshotResult = await this.verifySnapshot(workDir);

      return {
        valid: checksumResult.valid && parityResult.valid && walResult.valid && snapshotResult.valid,
        checksums: checksumResult,
        parity: parityResult,
        wal: walResult,
        snapshot: snapshotResult
      };

    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // List archives (local + remote)
  async listArchives(options = {}) {
    const local = await this.listLocalArchives();
    const remote = this.remote ? await this.listRemoteArchives() : [];

    return {
      local,
      remote,
      all: [...local, ...remote].sort((a, b) => b.createdAt - a.createdAt)
    };
  }

  // Schedule automatic archival
  startScheduler(config) {
    if (config.schedule) {
      this.scheduler = cron.schedule(config.schedule, () => this.createArchive());
    }

    if (config.intervalMs) {
      this.intervalTimer = setInterval(() => this.createArchive(), config.intervalMs);
    }
  }

  stopScheduler() {
    if (this.scheduler) this.scheduler.stop();
    if (this.intervalTimer) clearInterval(this.intervalTimer);
  }
}
```

### 5. Compression Implementation

**File**: `archive/compression.js`

```javascript
import { compress, decompress } from 'zstd-napi';  // Or pure JS fallback

export class ArchiveCompressor {
  constructor(options = {}) {
    this.algorithm = options.algorithm || 'zstd';
    this.level = options.level || 19;  // Max compression
  }

  async compress(inputPath, outputPath) {
    const input = await fs.readFile(inputPath);
    const compressed = await compress(input, { level: this.level });
    await fs.writeFile(outputPath, compressed);

    return {
      originalSize: input.length,
      compressedSize: compressed.length,
      ratio: compressed.length / input.length
    };
  }

  async decompress(inputPath, outputPath) {
    const input = await fs.readFile(inputPath);
    const decompressed = await decompress(input);
    await fs.writeFile(outputPath, decompressed);

    return {
      compressedSize: input.length,
      originalSize: decompressed.length
    };
  }

  // Stream compression for large files
  createCompressStream() {
    return zstd.compressStream({ level: this.level });
  }

  createDecompressStream() {
    return zstd.decompressStream();
  }
}
```

### 6. Error Correction (PAR2)

**File**: `archive/error-correction.js`

```javascript
export class ErrorCorrection {
  constructor(options = {}) {
    this.redundancy = options.redundancy || 0.1;  // 10% parity
    this.blockSize = options.blockSize || 4096;
  }

  // Generate PAR2 parity files
  async generateParity(files, outputDir) {
    const parityPath = path.join(outputDir, 'recovery.par2');

    // Calculate number of recovery blocks (10% redundancy)
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const recoveryBlocks = Math.ceil((totalSize * this.redundancy) / this.blockSize);

    // Generate PAR2 files
    await execAsync(`par2 create -r${this.redundancy * 100} -n${recoveryBlocks} ${parityPath} ${files.map(f => f.path).join(' ')}`);

    return {
      parityFile: parityPath,
      recoveryBlocks,
      redundancyPercent: this.redundancy * 100
    };
  }

  // Verify files using PAR2
  async verify(parityPath) {
    try {
      await execAsync(`par2 verify ${parityPath}`);
      return { valid: true, repairNeeded: false };
    } catch (error) {
      if (error.message.includes('repair')) {
        return { valid: false, repairNeeded: true };
      }
      throw error;
    }
  }

  // Repair corrupted files using PAR2
  async repair(parityPath) {
    try {
      await execAsync(`par2 repair ${parityPath}`);
      return { repaired: true };
    } catch (error) {
      return { repaired: false, error: error.message };
    }
  }
}
```

### 7. Checksum Verification

**File**: `archive/checksums.js`

```javascript
import { createHash } from 'crypto';

export class ChecksumManager {
  constructor(algorithm = 'sha256') {
    this.algorithm = algorithm;
  }

  async hashFile(filePath) {
    const hash = createHash(this.algorithm);
    const stream = fs.createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(`${this.algorithm}:${hash.digest('hex')}`));
      stream.on('error', reject);
    });
  }

  async generateChecksums(directory) {
    const checksums = {};
    const files = await this.walkDirectory(directory);

    for (const file of files) {
      const relativePath = path.relative(directory, file);
      checksums[relativePath] = await this.hashFile(file);
    }

    // Write checksums file
    const checksumPath = path.join(directory, 'checksums.sha256');
    const content = Object.entries(checksums)
      .map(([file, hash]) => `${hash}  ${file}`)
      .join('\n');
    await fs.writeFile(checksumPath, content);

    return checksums;
  }

  async verifyChecksums(directory) {
    const checksumPath = path.join(directory, 'checksums.sha256');
    const content = await fs.readFile(checksumPath, 'utf-8');

    const results = { valid: true, files: {} };

    for (const line of content.split('\n').filter(Boolean)) {
      const [expectedHash, filePath] = line.split('  ');
      const actualHash = await this.hashFile(path.join(directory, filePath));

      results.files[filePath] = {
        expected: expectedHash,
        actual: actualHash,
        valid: expectedHash === actualHash
      };

      if (expectedHash !== actualHash) {
        results.valid = false;
      }
    }

    return results;
  }
}
```

### 8. Remote Storage Providers

**File**: `archive/remote/s3.js`

```javascript
export class S3ArchiveStorage {
  constructor(options) {
    this.bucket = options.bucket;
    this.prefix = options.prefix || 'bri-archives/';
    this.region = options.region || 'us-east-1';
    this.client = new S3Client({ region: this.region });
  }

  async upload(localPath, archiveId) {
    const key = `${this.prefix}${archiveId}.bri.zst`;

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: 'application/x-bri-archive',
      Metadata: {
        'archive-id': archiveId,
        'created-at': new Date().toISOString()
      },
      StorageClass: 'STANDARD_IA'  // Infrequent access for cost savings
    }));

    return { bucket: this.bucket, key };
  }

  async download(archiveId, localPath) {
    const key = `${this.prefix}${archiveId}.bri.zst`;

    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key
    }));

    const writeStream = fs.createWriteStream(localPath);
    await pipeline(response.Body, writeStream);

    return localPath;
  }

  async list() {
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: this.prefix
    }));

    return response.Contents.map(obj => ({
      archiveId: obj.Key.replace(this.prefix, '').replace('.bri.zst', ''),
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified
    }));
  }

  async delete(archiveId) {
    const key = `${this.prefix}${archiveId}.bri.zst`;

    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key
    }));
  }
}
```

### 9. Archive Creation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    ARCHIVE CREATION FLOW                         │
└─────────────────────────────────────────────────────────────────┘

Trigger (schedule/size/manual)
            │
            ▼
┌───────────────────────┐
│ 1. Create Snapshot    │  Create point-in-time snapshot
│    for archive start  │  Record WAL line number
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 2. Collect WAL        │  Gather segments since last archive
│    segments           │  Verify chain integrity
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 3. Compress files     │  ZSTD level 19 compression
│    (ZSTD)             │  ~80-90% size reduction
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 4. Generate           │  SHA256 for each file
│    checksums          │  Write checksums.sha256
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 5. Generate PAR2      │  10% redundancy parity data
│    parity data        │  Enables corruption recovery
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 6. Create manifest    │  Archive metadata
│                       │  Time range, stats, checksums
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 7. Package archive    │  Single .bri.zst file
│                       │  or directory structure
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 8. Upload to remote   │  S3, GCS, Azure, etc.
│    (if configured)    │  Apply lifecycle policies
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ 9. Cleanup old WAL    │  Remove archived segments
│    segments           │  Free local storage
└───────────────────────┘
```

---

# PART 2: RESTORE SYSTEM

## Restore Architecture

### 1. Restore Sources

```
┌─────────────────────────────────────────────────────────────┐
│                    RESTORE SOURCES                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Local Archives         Remote Archives      Direct Files    │
│  ./data/archives/       s3://bucket/         ./backup.bri    │
│  arc_2024-01-15.bri     gs://bucket/                         │
│                         azure://container/                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2. Restore Manager

**File**: `archive/restore.js`

```javascript
export class RestoreManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.tempDir = options.tempDir || path.join(this.dataDir, 'restore-tmp');
    this.sources = options.sources || [];
    this.providers = new Map();

    // Initialize storage providers
    this.initializeProviders();
  }

  // List available archives from all sources
  async listArchives(options = {}) {
    const archives = [];

    for (const source of this.sources) {
      const provider = this.providers.get(source.type);
      const sourceArchives = await provider.list(source);

      archives.push(...sourceArchives.map(a => ({
        ...a,
        source: source.type,
        sourceConfig: source
      })));
    }

    // Sort by date descending
    archives.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Filter by options
    if (options.after) {
      return archives.filter(a => new Date(a.timeRange.end) > new Date(options.after));
    }
    if (options.before) {
      return archives.filter(a => new Date(a.timeRange.start) < new Date(options.before));
    }

    return archives;
  }

  // Find archive containing specific timestamp
  async findArchiveForTimestamp(timestamp) {
    const archives = await this.listArchives();
    const ts = new Date(timestamp);

    return archives.find(a =>
      new Date(a.timeRange.start) <= ts &&
      new Date(a.timeRange.end) >= ts
    );
  }

  // Full restore from archive
  async restore(options = {}) {
    const {
      archiveId,           // Specific archive to restore
      timestamp,           // Or point-in-time to restore to
      targetDir,           // Where to restore (default: this.dataDir)
      verify = true,       // Verify archive before restore
      cleanExisting = false, // Remove existing data first
      dryRun = false       // Simulate without actual restore
    } = options;

    // 1. Find the archive
    let archive;
    if (archiveId) {
      archive = await this.getArchiveInfo(archiveId);
    } else if (timestamp) {
      archive = await this.findArchiveForTimestamp(timestamp);
      if (!archive) {
        throw new RestoreError(`No archive found containing timestamp: ${timestamp}`);
      }
    } else {
      // Default to most recent
      const archives = await this.listArchives();
      archive = archives[0];
    }

    if (!archive) {
      throw new RestoreError('No archive available for restore');
    }

    console.log(`BRI Restore: Using archive ${archive.archiveId}`);
    console.log(`BRI Restore: Time range: ${archive.timeRange.start} - ${archive.timeRange.end}`);

    if (dryRun) {
      return { dryRun: true, archive, wouldRestore: true };
    }

    // 2. Fetch archive
    const archivePath = await this.fetchArchive(archive.archiveId, archive.sourceConfig);

    // 3. Verify integrity
    if (verify) {
      const verification = await this.verifyArchive(archivePath);
      if (!verification.valid) {
        // Attempt repair
        if (verification.repairPossible) {
          await this.repairArchive(archivePath);
        } else {
          throw new RestoreError('Archive verification failed and repair not possible');
        }
      }
    }

    // 4. Extract archive
    const extractDir = path.join(this.tempDir, 'extracted');
    await this.extractArchive(archivePath, extractDir);

    // 5. Prepare target directory
    const restoreTarget = targetDir || this.dataDir;

    if (cleanExisting) {
      await this.cleanDirectory(restoreTarget);
    } else {
      // Backup existing data
      await this.backupExisting(restoreTarget);
    }

    // 6. Restore snapshot
    await this.restoreSnapshot(extractDir, restoreTarget);

    // 7. Restore WAL segments
    await this.restoreWal(extractDir, restoreTarget);

    // 8. If point-in-time, replay WAL to specific point
    if (timestamp) {
      await this.replayWalToTimestamp(restoreTarget, timestamp);
    }

    // 9. Cleanup temp files
    await fs.rm(this.tempDir, { recursive: true, force: true });

    return {
      success: true,
      archive: archive.archiveId,
      restoredTo: restoreTarget,
      timestamp: timestamp || archive.timeRange.end
    };
  }

  // Replay WAL to specific timestamp for point-in-time recovery
  async replayWalToTimestamp(dataDir, targetTimestamp) {
    const walDir = path.join(dataDir, 'wal');
    const walReader = new WALReader(walDir);

    const ts = new Date(targetTimestamp).getTime();
    let lastValidLine = 0;

    // Find last entry before target timestamp
    for await (const entry of walReader.readEntries()) {
      if (entry._timestamp <= ts) {
        lastValidLine = entry._lineNumber;
      } else {
        break;
      }
    }

    // Truncate WAL after this point
    await this.truncateWal(walDir, lastValidLine);

    // Update snapshot to reflect point-in-time
    await this.updateSnapshotWalLine(dataDir, lastValidLine);

    console.log(`BRI Restore: Rolled back to line ${lastValidLine} (${new Date(ts).toISOString()})`);
  }

  // Clone database to new location
  async clone(options = {}) {
    const { archiveId, targetDir, newInstanceId } = options;

    const result = await this.restore({
      archiveId,
      targetDir,
      cleanExisting: true
    });

    if (newInstanceId) {
      await this.updateInstanceId(targetDir, newInstanceId);
    }

    return {
      ...result,
      clonedTo: targetDir,
      instanceId: newInstanceId
    };
  }
}
```

### 3. Restore Process Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     RESTORE PROCESS FLOW                         │
└─────────────────────────────────────────────────────────────────┘

User triggers restore
         │
         ▼
┌────────────────────┐
│ 1. Find Archive    │  Query sources for available archives
│                    │  Match by ID or timestamp
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 2. Fetch Archive   │  Download from remote/local source
│                    │  Stream to temp directory
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 3. Verify          │  Check checksums
│    Integrity       │  Verify PAR2 parity
│                    │  Repair if needed
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 4. Extract         │  Decompress ZSTD files
│    Archive         │  Extract snapshot + WAL
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 5. Backup          │  Move existing data to backup
│    Existing        │  (unless clean restore)
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 6. Restore         │  Copy decompressed snapshot
│    Snapshot        │  to data directory
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 7. Restore WAL     │  Copy decompressed WAL segments
│                    │  to data/wal directory
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 8. Point-in-Time   │  (If timestamp specified)
│    Truncation      │  Truncate WAL at timestamp
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ 9. Cleanup         │  Remove temp files
│                    │  Log restore completion
└────────────────────┘
```

### 4. Restore Hooks

```javascript
const db = await createDB({
  archive: {
    sources: [...],

    hooks: {
      beforeRestore: async (archive) => {
        console.log(`Starting restore from ${archive.archiveId}`);
        await notifyTeam('Database restore initiated');
      },

      afterSnapshotRestore: async (snapshotPath) => {
        console.log('Snapshot restored');
      },

      afterWalSegmentRestore: async (segment, progress) => {
        console.log(`Restored ${progress.current}/${progress.total} segments`);
      },

      afterRestore: async (result) => {
        console.log(`Restore complete: ${result.archive}`);
        await notifyTeam('Database restore complete');
      },

      onError: async (error) => {
        await notifyTeam(`Restore failed: ${error.message}`);
      }
    }
  }
});
```

### 5. Post-Restore Validation

```javascript
async validateRestore(dataDir) {
  const results = {
    valid: true,
    checks: []
  };

  // 1. Verify snapshot loads
  const snapshotCheck = await this.verifySnapshotLoads(dataDir);
  results.checks.push(snapshotCheck);

  // 2. Verify WAL chain integrity
  const walCheck = await this.verifyWalChain(dataDir);
  results.checks.push(walCheck);

  // 3. Count documents match manifest
  const countCheck = await this.verifyDocumentCounts(dataDir);
  results.checks.push(countCheck);

  // 4. Verify index consistency
  const indexCheck = await this.verifyIndexes(dataDir);
  results.checks.push(indexCheck);

  results.valid = results.checks.every(c => c.valid);

  return results;
}
```

---

# UNIFIED API

## Configuration

```javascript
const db = await createDB({
  storeConfig: {
    dataDir: './data',
    maxMemoryMB: 256,

    archive: {
      enabled: true,

      // Local archive storage
      localDir: './data/archives',
      keepLocal: 3,              // Keep 3 most recent locally

      // Triggers
      triggers: {
        schedule: '0 2 * * *',   // 2 AM daily
        walSizeMB: 100,          // Or when WAL exceeds 100MB
        walSegments: 10,         // Or after 10 segments
        manual: true             // Allow manual triggering
      },

      // Compression
      compression: {
        algorithm: 'zstd',
        level: 19                // Max compression (1-22)
      },

      // Error correction
      errorCorrection: {
        enabled: true,
        redundancy: 0.1          // 10% parity data
      },

      // Remote storage (shared for archive/restore)
      remote: {
        provider: 's3',
        bucket: 'my-bri-archives',
        prefix: 'production/',
        region: 'us-east-1',

        // Lifecycle
        retentionDays: 365,
        storageClass: 'STANDARD_IA',
        glacierAfterDays: 90
      },

      // Restore sources (in priority order)
      restoreSources: [
        { type: 's3', bucket: 'my-bri-archives', prefix: 'production/', region: 'us-east-1' },
        { type: 'local', path: './data/archives' }
      ],

      // Cleanup
      cleanupWal: true,
      cleanupSnapshots: true
    }
  }
});
```

## Archive API

```javascript
// Manual archive creation
const archive = await db.archive.create({
  name: 'pre-migration-backup',
  retention: 'permanent'
});

// List archives
const archives = await db.archive.list();

// Get archive details
const details = await db.archive.get('arc_2024-01-15...');

// Verify archive integrity
const verification = await db.archive.verify('arc_2024-01-15...');

// Download archive from remote
await db.archive.download('arc_2024-01-15...', './backup.bri.zst');

// Delete archive
await db.archive.delete('arc_2024-01-15...');

// Get archive stats
const stats = await db.archive.stats();
```

## Restore API

```javascript
// List available archives for restore
const archives = await db.restore.list();
const s3Archives = await db.restore.list({ source: 's3' });

// Find archive for specific point in time
const archive = await db.restore.findForTimestamp('2024-01-15T10:30:00Z');

// Full restore from latest archive
await db.restore.fromLatest();

// Restore from specific archive
await db.restore.from('arc_2024-01-15...');

// Point-in-time restore
await db.restore.toTimestamp('2024-01-15T10:30:00Z');

// Clone to new directory
await db.restore.clone({
  archiveId: 'arc_2024-01-15...',
  targetDir: './data-clone',
  newInstanceId: 'bri-clone-01'
});

// Dry run
const plan = await db.restore.from('arc_2024-01-15...', { dryRun: true });

// Verify archive before restore
const verification = await db.restore.verify('arc_2024-01-15...');
```

## CLI Commands

```bash
# Archive commands
bri archive create --name "pre-migration"
bri archive list
bri archive verify arc_2024-01-15...
bri archive download arc_2024-01-15... ./backup.bri.zst
bri archive inspect ./backup.bri.zst
bri archive repair ./backup.bri.zst
bri archive delete arc_2024-01-15...
bri archive stats

# Restore commands
bri restore list
bri restore list --source s3
bri restore list --after 2024-01-01 --before 2024-02-01
bri restore info arc_2024-01-15...
bri restore latest
bri restore from arc_2024-01-15...
bri restore to-timestamp "2024-01-15T10:30:00Z"
bri restore from arc_2024-01-15... --verify
bri restore from arc_2024-01-15... --dry-run
bri restore clone arc_2024-01-15... --target ./data-clone
bri restore verify arc_2024-01-15...
bri restore from arc_2024-01-15... --force
```

---

## Error Handling

```javascript
// archive/errors.js
export class ArchiveError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.details = details;
  }
}

export class ArchiveNotFoundError extends ArchiveError {
  constructor(archiveId) {
    super(`Archive not found: ${archiveId}`, 'ARCHIVE_NOT_FOUND');
    this.archiveId = archiveId;
  }
}

export class ArchiveCorruptedError extends ArchiveError {
  constructor(archiveId, checksumErrors) {
    super(`Archive corrupted: ${archiveId}`, 'ARCHIVE_CORRUPTED');
    this.archiveId = archiveId;
    this.checksumErrors = checksumErrors;
  }
}

export class RestoreError extends ArchiveError {
  constructor(message, code = 'RESTORE_ERROR') {
    super(message, code);
    this.name = 'RestoreError';
  }
}

export class PointInTimeError extends RestoreError {
  constructor(timestamp, availableRange) {
    super(`Timestamp ${timestamp} not available in archives`, 'TIMESTAMP_NOT_FOUND');
    this.timestamp = timestamp;
    this.availableRange = availableRange;
  }
}
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `archive/manager.js` | Create | Archive creation and management |
| `archive/restore.js` | Create | Restore orchestration |
| `archive/compression.js` | Create | ZSTD compression |
| `archive/checksums.js` | Create | SHA256 checksums |
| `archive/error-correction.js` | Create | PAR2 parity generation |
| `archive/remote/index.js` | Create | Remote storage interface |
| `archive/remote/s3.js` | Create | S3 provider |
| `archive/remote/gcs.js` | Create | GCS provider |
| `archive/remote/azure.js` | Create | Azure Blob provider |
| `archive/remote/local.js` | Create | Local filesystem provider |
| `archive/errors.js` | Create | Archive/restore errors |
| `archive/validation.js` | Create | Post-restore validation |
| `archive/index.js` | Create | Module exports |
| `storage/adapters/inhouse.js` | Modify | Integrate archive manager |
| `client/proxy.js` | Modify | Add db.archive and db.restore namespaces |

## Dependencies

| Package | Purpose |
|---------|---------|
| `zstd-napi` or `fzstd` | ZSTD compression |
| `@aws-sdk/client-s3` | S3 remote storage |
| `@google-cloud/storage` | GCS remote storage |
| `@azure/storage-blob` | Azure remote storage |
| `node-cron` | Archive scheduling |

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `archive.enabled` | boolean | false | Enable archive system |
| `archive.localDir` | string | ./data/archives | Local archive storage |
| `archive.keepLocal` | number | 3 | Local archives to retain |
| `archive.triggers.schedule` | string | null | Cron schedule |
| `archive.triggers.walSizeMB` | number | null | WAL size trigger |
| `archive.compression.algorithm` | string | zstd | Compression algorithm |
| `archive.compression.level` | number | 19 | Compression level |
| `archive.errorCorrection.enabled` | boolean | true | Enable PAR2 |
| `archive.errorCorrection.redundancy` | number | 0.1 | Parity percentage |
| `archive.remote.provider` | string | null | Remote provider type |
| `archive.restoreSources` | array | [] | Restore source priority |
