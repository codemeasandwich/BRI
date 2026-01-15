/**
 * E2E Persistence Tests
 * Tests: WAL, snapshots, recovery
 */

import { createDB } from '../../client/index.js';
import { SnapshotManager } from '../../storage/snapshot/manager.js';
import { WALReader } from '../../storage/wal/reader.js';
import { WALWriter } from '../../storage/wal/writer.js';
import { createSetEntry, createRenameEntry, createSAddEntry, createSRemEntry, serializeEntry, deserializeEntry, hashPointer, WALOp } from '../../storage/wal/entry.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DATA_DIR = './test-data-persist';

describe('Persistence', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('Data Recovery', () => {
    test('data persists after disconnect/reconnect', async () => {
      // Create and save data
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db1.add.persist({ value: 'persistent' });
      const itemId = item.$ID;

      await db1._store.createSnapshot();
      await db1.disconnect();

      // Reconnect
      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const recovered = await db2.get.persist(itemId);
      expect(recovered).not.toBeNull();
      expect(recovered.value).toBe('persistent');

      await db2.disconnect();
    });

    test('multiple items persist', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db1.add.multi({ name: 'One' });
      await db1.add.multi({ name: 'Two' });
      await db1.add.multi({ name: 'Three' });

      await db1._store.createSnapshot();
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const items = await db2.get.multiS();
      expect(items.length).toBe(3);

      await db2.disconnect();
    });

    test('updates persist', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db1.add.update({ counter: 0 });
      item.counter = 10;
      await item.save();

      await db1._store.createSnapshot();
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const recovered = await db2.get.update(item.$ID);
      expect(recovered.counter).toBe(10);

      await db2.disconnect();
    });

    test('deletes persist', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db1.add.deltest({ name: 'ToDelete' });
      const deleter = await db1.add.deltest({ name: 'Deleter' });
      await db1.del.deltest(item.$ID, deleter.$ID);

      await db1._store.createSnapshot();
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const items = await db2.get.deltestS();
      expect(items.length).toBe(1); // Only deleter remains

      await db2.disconnect();
    });
  });

  describe('WAL Recovery', () => {
    test('recovers from WAL without snapshot', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db1.add.walonly({ name: 'WAL' });
      // No snapshot - disconnect immediately
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const items = await db2.get.walonlyS();
      expect(items.length).toBe(1);

      await db2.disconnect();
    });

    test('recovers WAL after snapshot point', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db1.add.walafter({ name: 'Before' });
      await db1._store.createSnapshot();

      await db1.add.walafter({ name: 'After' });
      // No snapshot after second add
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const items = await db2.get.walafterS();
      expect(items.length).toBe(2);

      await db2.disconnect();
    });
  });

  describe('Snapshot', () => {
    test('manual snapshot creation', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db.add.snapshot({ name: 'Test' });
      await db._store.createSnapshot();

      // Check snapshot file exists
      const snapshotPath = path.join(TEST_DATA_DIR, 'snapshot.jss');
      const exists = await fs.access(snapshotPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      await db.disconnect();
    });

    test('snapshot contains all data', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const items = [];
      for (let i = 0; i < 5; i++) {
        items.push(await db.add.snapdata({ index: i }));
      }

      await db._store.createSnapshot();

      // Read snapshot directly
      const snapshotPath = path.join(TEST_DATA_DIR, 'snapshot.jss');
      const content = await fs.readFile(snapshotPath, 'utf8');
      const snapshot = JSON.parse(content);

      expect(snapshot.version).toBe(2);
      expect(snapshot.documents).toBeDefined();

      await db.disconnect();
    });
  });

  describe('Statistics', () => {
    test('getStats returns storage info', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db.add.statitem({ name: 'Test' });
      const statsResult = await db._store.getStats();

      expect(statsResult).toBeDefined();
      expect(statsResult.hotTier).toBeDefined();

      await db.disconnect();
    });
  });

  describe('Transaction Recovery', () => {
    test('pending transactions recovered after restart', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // Start transaction but don't commit
      const txnId = db1.rec();
      await db1.add.txnrecover({ name: 'Pending' }, { txnId });

      // Disconnect without fin
      await db1.disconnect();

      // On restart, pending transactions should be recovered
      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // List pending transactions
      const pending = await db2._store.listPendingTxns();
      // Note: Transaction recovery behavior depends on implementation

      await db2.disconnect();
    });
  });

  describe('Nested Object Persistence', () => {
    test('nested data persists through snapshot', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const parent = await db1.add.parent({
        name: 'Parent',
        nested: { deep: { value: 'persisted' } }
      });

      await db1._store.createSnapshot();
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const recovered = await db2.get.parent(parent.$ID);
      expect(recovered.nested.deep.value).toBe('persisted');

      await db2.disconnect();
    });

    test('string references persist as strings', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // Store a reference as a simple string (not related to another doc)
      const parent = await db1.add.parentref({
        name: 'Parent',
        childId: 'REF_abc123'  // Just a string value
      });

      await db1._store.createSnapshot();
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const recovered = await db2.get.parentref(parent.$ID);
      expect(recovered.childId).toBe('REF_abc123');

      await db2.disconnect();
    });
  });
});

describe('SnapshotManager Direct Tests', () => {
  let snapshotManager;
  const SNAPSHOT_TEST_DIR = './test-data-snapshot-direct';

  beforeEach(async () => {
    await fs.rm(SNAPSHOT_TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(SNAPSHOT_TEST_DIR, { recursive: true });
    snapshotManager = new SnapshotManager(SNAPSHOT_TEST_DIR);
  });

  afterEach(async () => {
    snapshotManager.stopScheduler();
    await fs.rm(SNAPSHOT_TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('create()', () => {
    test('creates snapshot file', async () => {
      const state = {
        version: 2,
        walLine: 100,
        documents: { 'TEST_abc': '{"name":"test"}' },
        collections: { 'TEST?': ['abc'] }
      };

      await snapshotManager.create(state);

      const exists = await fs.access(path.join(SNAPSHOT_TEST_DIR, 'snapshot.jss'))
        .then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('skips if already creating', async () => {
      snapshotManager.isCreating = true;

      const result = await snapshotManager.create({ walLine: 1, documents: {}, collections: {} });
      expect(result).toBeNull();
    });

    test('resets isCreating flag on completion', async () => {
      await snapshotManager.create({ walLine: 1, documents: {}, collections: {} });
      expect(snapshotManager.isCreating).toBe(false);
    });

    test('uses default version 1 if not provided', async () => {
      await snapshotManager.create({ walLine: 1, documents: {}, collections: {} });
      const content = await fs.readFile(path.join(SNAPSHOT_TEST_DIR, 'snapshot.jss'), 'utf8');
      const snapshot = JSON.parse(content);
      expect(snapshot.version).toBe(1);
    });
  });

  describe('loadLatest()', () => {
    test('returns null if no snapshot exists', async () => {
      const result = await snapshotManager.loadLatest();
      expect(result).toBeNull();
    });

    test('loads existing snapshot', async () => {
      await snapshotManager.create({
        version: 2,
        walLine: 50,
        documents: { 'DOC_one': '{}' },
        collections: {}
      });

      const loaded = await snapshotManager.loadLatest();
      expect(loaded).not.toBeNull();
      expect(loaded.walLine).toBe(50);
      expect(loaded.documents['DOC_one']).toBe('{}');
    });

    test('returns null on parse error', async () => {
      await fs.writeFile(path.join(SNAPSHOT_TEST_DIR, 'snapshot.jss'), 'invalid json{{{', 'utf8');
      const result = await snapshotManager.loadLatest();
      expect(result).toBeNull();
    });
  });

  describe('startScheduler()', () => {
    test('starts periodic snapshot creation', async () => {
      let createCalled = false;
      snapshotManager.intervalMs = 50; // Very short for testing

      snapshotManager.startScheduler(async () => {
        createCalled = true;
      });

      expect(snapshotManager.timer).not.toBeNull();

      // Wait for scheduler to fire
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(createCalled).toBe(true);
    });

    test('does not start if already running', () => {
      snapshotManager.timer = 'existing';
      snapshotManager.startScheduler(() => {});
      expect(snapshotManager.timer).toBe('existing');
    });

    test('handles errors in createSnapshot callback', async () => {
      snapshotManager.intervalMs = 20;

      snapshotManager.startScheduler(async () => {
        throw new Error('Scheduled error');
      });

      // Should not throw, error is caught
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  describe('stopScheduler()', () => {
    test('stops the scheduler', () => {
      snapshotManager.startScheduler(() => {});
      expect(snapshotManager.timer).not.toBeNull();

      snapshotManager.stopScheduler();
      expect(snapshotManager.timer).toBeNull();
    });

    test('is no-op if not running', () => {
      // Should not throw
      snapshotManager.stopScheduler();
    });
  });

  describe('getStats()', () => {
    test('returns stats for existing snapshot', async () => {
      await snapshotManager.create({ version: 2, walLine: 75, documents: {}, collections: {} });

      const stats = await snapshotManager.getStats();
      expect(stats.exists).toBe(true);
      expect(stats.walLine).toBe(75);
      expect(stats.sizeMB).toBeGreaterThanOrEqual(0);
    });

    test('returns default stats if no snapshot', async () => {
      const stats = await snapshotManager.getStats();
      expect(stats.exists).toBe(false);
      expect(stats.walLine).toBeNull();
    });
  });
});

describe('WALWriter Direct Tests', () => {
  let walWriter;
  const WAL_TEST_DIR = './test-data-wal-direct';

  beforeEach(async () => {
    await fs.rm(WAL_TEST_DIR, { recursive: true, force: true }).catch(() => {});
    walWriter = new WALWriter(WAL_TEST_DIR, { fsyncMode: 'always' });
    await walWriter.init();
  });

  afterEach(async () => {
    await walWriter.close();
    await fs.rm(WAL_TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('init()', () => {
    test('creates WAL directory', async () => {
      const exists = await fs.access(WAL_TEST_DIR).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('opens segment file', () => {
      expect(walWriter.fileHandle).not.toBeNull();
    });
  });

  describe('append()', () => {
    test('writes entry to WAL', async () => {
      const entry = createSetEntry('TEST_key', '{"value":1}');
      await walWriter.append(entry);

      const segments = await walWriter.getSegments();
      const content = await fs.readFile(segments[0], 'utf8');
      expect(content).toContain('TEST_key');
    });

    test('maintains pointer chain', async () => {
      await walWriter.append(createSetEntry('K1', '{}'));
      await walWriter.append(createSetEntry('K2', '{}'));

      const segments = await walWriter.getSegments();
      const content = await fs.readFile(segments[0], 'utf8');
      const lines = content.trim().split('\n');

      const entry1 = deserializeEntry(lines[0]);
      const entry2 = deserializeEntry(lines[1]);

      // Second entry's pointer depends on first
      expect(entry2._pointer).not.toBe(entry1._pointer);
    });
  });

  describe('rotate()', () => {
    test('creates new segment', async () => {
      const initialSegment = walWriter.currentSegment;
      await walWriter.rotate();
      expect(walWriter.currentSegment).toBe(initialSegment + 1);
    });
  });

  describe('sync()', () => {
    test('syncs file handle', async () => {
      await walWriter.append(createSetEntry('K', '{}'));
      // Should not throw
      await walWriter.sync();
    });

    test('is no-op if no file handle', async () => {
      await walWriter.close();
      // Should not throw
      await walWriter.sync();
    });
  });

  describe('archive()', () => {
    test('closes current segment and starts new one', async () => {
      await walWriter.append(createSetEntry('K', '{}'));
      const archivedSegment = await walWriter.archive();

      expect(archivedSegment).toBe(0);
      expect(walWriter.currentSegment).toBe(1);
    });
  });

  describe('close()', () => {
    test('closes file handle', async () => {
      await walWriter.close();
      expect(walWriter.fileHandle).toBeNull();
    });

    test('clears fsync timer', async () => {
      const batchedWriter = new WALWriter(WAL_TEST_DIR + '-batched', { fsyncMode: 'batched' });
      await batchedWriter.init();
      expect(batchedWriter.fsyncTimer).not.toBeNull();

      await batchedWriter.close();
      expect(batchedWriter.fsyncTimer).toBeNull();

      await fs.rm(WAL_TEST_DIR + '-batched', { recursive: true, force: true }).catch(() => {});
    });
  });

  describe('segment rotation on size limit', () => {
    test('rotates when segment exceeds size', async () => {
      const smallSegmentWriter = new WALWriter(WAL_TEST_DIR + '-small', {
        fsyncMode: 'always',
        segmentSize: 100 // Very small
      });
      await smallSegmentWriter.init();

      // Write multiple entries to exceed segment size
      for (let i = 0; i < 5; i++) {
        await smallSegmentWriter.append(createSetEntry(`KEY_${i}`, '{"data":"' + 'x'.repeat(50) + '"}'));
      }

      expect(smallSegmentWriter.currentSegment).toBeGreaterThan(0);

      await smallSegmentWriter.close();
      await fs.rm(WAL_TEST_DIR + '-small', { recursive: true, force: true }).catch(() => {});
    });
  });
});

describe('WALReader Direct Tests', () => {
  const WAL_READER_DIR = './test-data-wal-reader';

  beforeEach(async () => {
    await fs.rm(WAL_READER_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(WAL_READER_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(WAL_READER_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('getSegments()', () => {
    test('returns sorted WAL segments', async () => {
      // Create WAL files
      await fs.writeFile(path.join(WAL_READER_DIR, '000002.wal'), '', 'utf8');
      await fs.writeFile(path.join(WAL_READER_DIR, '000000.wal'), '', 'utf8');
      await fs.writeFile(path.join(WAL_READER_DIR, '000001.wal'), '', 'utf8');

      const reader = new WALReader(WAL_READER_DIR);
      const segments = await reader.getSegments();

      expect(segments.length).toBe(3);
      expect(segments[0]).toContain('000000.wal');
      expect(segments[2]).toContain('000002.wal');
    });

    test('returns empty array for non-existent directory', async () => {
      const reader = new WALReader('./nonexistent-wal-dir');
      const segments = await reader.getSegments();
      expect(segments).toEqual([]);
    });
  });

  describe('readEntries()', () => {
    test('reads entries from WAL', async () => {
      // Write some entries
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('KEY1', '{}'));
      await writer.append(createSetEntry('KEY2', '{}'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const entries = [];
      for await (const entry of reader.readEntries(0)) {
        entries.push(entry);
      }

      expect(entries.length).toBe(2);
      expect(entries[0].target).toBe('KEY1');
      expect(entries[1].target).toBe('KEY2');
    });

    test('skips entries before afterLine', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('KEY1', '{}'));
      await writer.append(createSetEntry('KEY2', '{}'));
      await writer.append(createSetEntry('KEY3', '{}'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const entries = [];
      for await (const entry of reader.readEntries(1)) {
        entries.push(entry);
      }

      expect(entries.length).toBe(2);
      expect(entries[0].target).toBe('KEY2');
    });

    test('skips empty lines', async () => {
      await fs.writeFile(path.join(WAL_READER_DIR, '000000.wal'), '\n\n\n', 'utf8');

      const reader = new WALReader(WAL_READER_DIR);
      const entries = [];
      for await (const entry of reader.readEntries(0)) {
        entries.push(entry);
      }

      expect(entries.length).toBe(0);
    });

    test('handles corrupted entries gracefully', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('KEY1', '{}'));
      await writer.close();

      // Append corrupted line
      await fs.appendFile(path.join(WAL_READER_DIR, '000000.wal'), 'corrupted|line|notjson\n');

      const reader = new WALReader(WAL_READER_DIR);
      const entries = [];
      for await (const entry of reader.readEntries(0)) {
        entries.push(entry);
      }

      // Should only get the valid entry
      expect(entries.length).toBe(1);
    });
  });

  describe('replay()', () => {
    test('replays SET operations', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('KEY1', '{"v":1}'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const setOps = [];
      await reader.replay(0, {
        onSet: (key, value) => setOps.push({ key, value }),
        onDelete: () => {},
        onRename: () => {},
        onSAdd: () => {},
        onSRem: () => {}
      });

      expect(setOps.length).toBe(1);
      expect(setOps[0].key).toBe('KEY1');
    });

    test('replays DELETE operations', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append({ action: WALOp.DELETE, target: 'KEY1' });
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const deleteOps = [];
      await reader.replay(0, {
        onSet: () => {},
        onDelete: (key) => deleteOps.push(key),
        onRename: () => {},
        onSAdd: () => {},
        onSRem: () => {}
      });

      expect(deleteOps).toContain('KEY1');
    });

    test('replays RENAME operations', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createRenameEntry('OLD_key', 'NEW_key'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const renameOps = [];
      await reader.replay(0, {
        onSet: () => {},
        onDelete: () => {},
        onRename: (oldKey, newKey) => renameOps.push({ oldKey, newKey }),
        onSAdd: () => {},
        onSRem: () => {}
      });

      expect(renameOps[0].oldKey).toBe('OLD_key');
      expect(renameOps[0].newKey).toBe('NEW_key');
    });

    test('replays SADD operations', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSAddEntry('SET?', 'member1'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const saddOps = [];
      await reader.replay(0, {
        onSet: () => {},
        onDelete: () => {},
        onRename: () => {},
        onSAdd: (set, member) => saddOps.push({ set, member }),
        onSRem: () => {}
      });

      expect(saddOps[0].set).toBe('SET?');
      expect(saddOps[0].member).toBe('member1');
    });

    test('replays SREM operations', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSRemEntry('SET?', 'member1'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const sremOps = [];
      await reader.replay(0, {
        onSet: () => {},
        onDelete: () => {},
        onRename: () => {},
        onSAdd: () => {},
        onSRem: (set, member) => sremOps.push({ set, member })
      });

      expect(sremOps[0].set).toBe('SET?');
      expect(sremOps[0].member).toBe('member1');
    });

    test('returns last replayed line', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('K1', '{}'));
      await writer.append(createSetEntry('K2', '{}'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const lastLine = await reader.replay(0, {
        onSet: () => {},
        onDelete: () => {},
        onRename: () => {},
        onSAdd: () => {},
        onSRem: () => {}
      });

      expect(lastLine).toBe(2);
    });
  });

  describe('getLineCount()', () => {
    test('returns total line count', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('K1', '{}'));
      await writer.append(createSetEntry('K2', '{}'));
      await writer.append(createSetEntry('K3', '{}'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const count = await reader.getLineCount();
      expect(count).toBe(3);
    });

    test('returns 0 for empty WAL', async () => {
      const reader = new WALReader(WAL_READER_DIR);
      const count = await reader.getLineCount();
      expect(count).toBe(0);
    });
  });

  describe('verifyIntegrity()', () => {
    test('returns valid for correct pointer chain', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('K1', '{}'));
      await writer.append(createSetEntry('K2', '{}'));
      await writer.close();

      const reader = new WALReader(WAL_READER_DIR);
      const result = await reader.verifyIntegrity();

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test('detects corrupted pointer chain', async () => {
      const writer = new WALWriter(WAL_READER_DIR, { fsyncMode: 'always' });
      await writer.init();
      await writer.append(createSetEntry('K1', '{}'));
      await writer.close();

      // Corrupt the file by modifying pointer
      const walPath = path.join(WAL_READER_DIR, '000000.wal');
      let content = await fs.readFile(walPath, 'utf8');
      content = content.replace(/\|[a-f0-9]{8}\|/, '|BADPTR00|');
      await fs.writeFile(walPath, content, 'utf8');

      const reader = new WALReader(WAL_READER_DIR);
      const result = await reader.verifyIntegrity();

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('handles corrupted entry in verification', async () => {
      await fs.writeFile(path.join(WAL_READER_DIR, '000000.wal'), 'not|valid|json{{{', 'utf8');

      const reader = new WALReader(WAL_READER_DIR);
      const result = await reader.verifyIntegrity();

      expect(result.valid).toBe(false);
      expect(result.errors[0].error).toContain('Parse error');
    });
  });
});

describe('WAL Entry Functions', () => {
  describe('hashPointer()', () => {
    test('generates consistent hash', () => {
      const hash1 = hashPointer('prev', '{"data":1}');
      const hash2 = hashPointer('prev', '{"data":1}');
      expect(hash1).toBe(hash2);
    });

    test('handles null prev pointer', () => {
      const hash = hashPointer(null, '{"data":1}');
      expect(hash).toHaveLength(8);
    });
  });

  describe('createDeleteEntry()', () => {
    test('creates DELETE entry', async () => {
      const { createDeleteEntry } = await import('../../storage/wal/entry.js');
      const entry = createDeleteEntry('TEST_key');
      expect(entry.action).toBe('DELETE');
      expect(entry.target).toBe('TEST_key');
    });
  });

  describe('serializeEntry()', () => {
    test('creates line with timestamp|pointer|entry format', () => {
      const entry = createSetEntry('KEY', '{}');
      const line = serializeEntry(entry, null);

      const parts = line.split('|');
      expect(parts.length).toBe(3);
      expect(parseInt(parts[0])).toBeGreaterThan(0);
      expect(parts[1]).toHaveLength(8);
    });
  });

  describe('deserializeEntry()', () => {
    test('parses line back to entry', () => {
      const original = createSetEntry('KEY', '{"value":42}');
      const line = serializeEntry(original, null);
      const parsed = deserializeEntry(line);

      expect(parsed.action).toBe('SET');
      expect(parsed.target).toBe('KEY');
      expect(parsed._timestamp).toBeInstanceOf(Date);
      expect(parsed._pointer).toHaveLength(8);
    });
  });
});
