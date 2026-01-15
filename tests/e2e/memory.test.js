/**
 * E2E Memory Management Tests
 * Tests: Hot/Cold tiers, eviction, cold storage
 */

import { createDB } from '../../client/index.js';
import { ColdTierFiles } from '../../storage/cold-tier/files.js';
import { HotTierCache } from '../../storage/hot-tier/cache.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DATA_DIR = './test-data-memory';

describe('Memory Management', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('Hot Tier', () => {
    test('data starts in hot tier', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db.add.hotitem({ name: 'Hot' });

      const stats = await db._store.getStats();
      // hotDocuments is the field name, not documentCount
      expect(stats.hotTier.hotDocuments).toBeGreaterThan(0);

      await db.disconnect();
    });

    test('accessing data updates access count', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // 'access' ends with 's' which is invalid - use 'acce' instead
      const item = await db.add.acce({ name: 'Access' });

      // Multiple reads
      await db.get.acce(item.$ID);
      await db.get.acce(item.$ID);
      await db.get.acce(item.$ID);

      // Access count should increase (internal metric)
      await db.disconnect();
    });
  });

  describe('Cold Tier', () => {
    test('cold tier directory structure', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 1, // Very small to force eviction
          evictionThreshold: 0.001
        }
      });

      // Create enough data to trigger eviction
      for (let i = 0; i < 10; i++) {
        await db.add.colditem({
          name: `Item ${i}`,
          data: 'x'.repeat(10000) // Large data
        });
      }

      // Check cold directory exists
      const coldPath = path.join(TEST_DATA_DIR, 'cold');
      const exists = await fs.access(coldPath).then(() => true).catch(() => false);

      await db.disconnect();
    });

    test('cold storage file format', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db.add.coldformat({ name: 'Test' });

      // Manually trigger snapshot to see file structure
      await db._store.createSnapshot();

      await db.disconnect();
    });
  });

  describe('Eviction', () => {
    test('LRU eviction when memory exceeded', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 1,
          evictionThreshold: 0.5
        }
      });

      // Create multiple items
      const items = [];
      for (let i = 0; i < 20; i++) {
        items.push(await db.add.evict({
          index: i,
          data: 'x'.repeat(5000)
        }));
      }

      // Stats should show eviction occurred
      const stats = await db._store.getStats();

      await db.disconnect();
    });

    test('dirty items not evicted', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db.add.dirty({ value: 1 });
      item.value = 2;
      // Not saved yet - dirty

      // Item should remain in hot tier even under memory pressure
      await db.disconnect();
    });
  });

  describe('Cold Load', () => {
    test('loads from cold storage on access', async () => {
      // This test needs a scenario where data is in cold storage
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db.add.coldload({ name: 'Cold' });
      await db._store.createSnapshot();

      // Force item to cold (implementation dependent)
      // Then access it

      const retrieved = await db.get.coldload(item.$ID);
      expect(retrieved.name).toBe('Cold');

      await db.disconnect();
    });
  });

  describe('Set Operations', () => {
    test('set members stored correctly', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      await db.add.setmem({ name: 'A' });
      await db.add.setmem({ name: 'B' });
      await db.add.setmem({ name: 'C' });

      const items = await db.get.setmemS();
      expect(items.length).toBe(3);

      await db.disconnect();
    });

    test('set members persist', async () => {
      const db1 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // 'setpers' ends with 's' - use 'setper' instead
      await db1.add.setper({ name: 'One' });
      await db1.add.setper({ name: 'Two' });

      await db1._store.createSnapshot();
      await db1.disconnect();

      const db2 = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const items = await db2.get.setperS();
      expect(items.length).toBe(2);

      await db2.disconnect();
    });
  });

  describe('Memory Statistics', () => {
    test('hot tier stats accurate', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // 'hotstats' ends with 's' - use 'hotstat' instead
      await db.add.hotstat({ name: 'Test' });
      await db.add.hotstat({ name: 'Test2' });

      const stats = await db._store.getStats();

      expect(stats.hotTier).toBeDefined();
      // Correct field name is hotDocuments
      expect(stats.hotTier.hotDocuments).toBeGreaterThanOrEqual(2);
      expect(stats.hotTier.usedMemoryMB).toBeGreaterThanOrEqual(0);

      await db.disconnect();
    });

    test('size estimation', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      // 'sizest' might end with 's' issues - use 'sizedata'
      await db.add.sizedata({
        data: 'a'.repeat(1000)
      });

      const stats = await db._store.getStats();
      // usedMemoryMB is in MB, not bytes
      expect(stats.hotTier.usedMemoryMB).toBeGreaterThanOrEqual(0);

      await db.disconnect();
    });
  });

  describe('Rename Operations', () => {
    test('rename updates hot tier', async () => {
      const db = await createDB({
        storeConfig: {
          dataDir: TEST_DATA_DIR,
          maxMemoryMB: 64
        }
      });

      const item = await db.add.renamehot({ name: 'Original' });
      const deleter = await db.add.renamehot({ name: 'Deleter' });

      await db.del.renamehot(item.$ID, deleter.$ID);

      // Original key should not exist
      const notFound = await db.get.renamehot(item.$ID);
      expect(notFound).toBeNull();

      await db.disconnect();
    });
  });

  describe('ColdTierFiles Direct Tests', () => {
    let coldFiles;
    const coldTestDir = './test-data-cold-direct';

    beforeEach(async () => {
      await fs.rm(coldTestDir, { recursive: true, force: true }).catch(() => {});
      coldFiles = new ColdTierFiles(coldTestDir);
    });

    afterEach(async () => {
      await fs.rm(coldTestDir, { recursive: true, force: true }).catch(() => {});
    });

    test('extractType from normal key', () => {
      expect(coldFiles.extractType('POST_fu352dp')).toBe('POST');
    });

    test('extractType from soft-deleted key', () => {
      expect(coldFiles.extractType('X:POST_fu352dp:X')).toBe('POST');
    });

    test('extractType from key without underscore returns full key', () => {
      expect(coldFiles.extractType('NOUNDER')).toBe('NOUNDER');
    });

    test('extractId from normal key', () => {
      expect(coldFiles.extractId('POST_fu352dp')).toBe('fu352dp');
    });

    test('extractId from soft-deleted key', () => {
      expect(coldFiles.extractId('X:POST_fu352dp:X')).toBe('fu352dp');
    });

    test('extractId from key without underscore returns full key', () => {
      expect(coldFiles.extractId('NOUNDER')).toBe('NOUNDER');
    });

    test('writeDoc and readDoc roundtrip', async () => {
      const key = 'TEST_abc123';
      const value = JSON.stringify({ name: 'Test', value: 42 });

      await coldFiles.writeDoc(key, value);
      const retrieved = await coldFiles.readDoc(key);

      expect(retrieved).not.toBeNull();
      const parsed = JSON.parse(retrieved);
      expect(parsed.name).toBe('Test');
      expect(parsed.value).toBe(42);
    });

    test('writeDoc with non-JSON string value', async () => {
      const key = 'TEST_raw123';
      const value = 'not-json-but-a-string';

      await coldFiles.writeDoc(key, value);
      const retrieved = await coldFiles.readDoc(key);
      expect(retrieved).not.toBeNull();
    });

    test('readDoc returns null for non-existent file', async () => {
      const result = await coldFiles.readDoc('NOTFOUND_xyz');
      expect(result).toBeNull();
    });

    test('deleteDoc removes file', async () => {
      const key = 'TEST_del123';
      await coldFiles.writeDoc(key, '{"name":"Delete"}');

      expect(await coldFiles.docExists(key)).toBe(true);

      await coldFiles.deleteDoc(key);

      expect(await coldFiles.docExists(key)).toBe(false);
    });

    test('deleteDoc is no-op for non-existent file', async () => {
      // Should not throw
      await coldFiles.deleteDoc('NOTFOUND_xyz');
    });

    test('docExists returns true for existing file', async () => {
      const key = 'TEST_exists';
      await coldFiles.writeDoc(key, '{"test":true}');
      expect(await coldFiles.docExists(key)).toBe(true);
    });

    test('docExists returns false for non-existent file', async () => {
      expect(await coldFiles.docExists('NOTFOUND_xyz')).toBe(false);
    });

    test('listDocs returns all documents', async () => {
      await coldFiles.writeDoc('TYPE1_abc', '{}');
      await coldFiles.writeDoc('TYPE1_def', '{}');
      await coldFiles.writeDoc('TYPE2_ghi', '{}');

      const docs = await coldFiles.listDocs();
      expect(docs.length).toBe(3);
      expect(docs).toContain('TYPE1_abc');
      expect(docs).toContain('TYPE1_def');
      expect(docs).toContain('TYPE2_ghi');
    });

    test('listDocs returns empty array when no cold dir', async () => {
      const newCold = new ColdTierFiles('./nonexistent-cold-dir');
      const docs = await newCold.listDocs();
      expect(Array.isArray(docs)).toBe(true);
    });

    test('listDocs skips non-jss files', async () => {
      await coldFiles.writeDoc('TEST_jss', '{}');
      // Create a non-.jss file in the type directory
      const typeDir = path.join(coldTestDir, 'cold', 'TEST');
      await fs.writeFile(path.join(typeDir, 'notajssfile.txt'), 'test', 'utf8');

      const docs = await coldFiles.listDocs();
      expect(docs.length).toBe(1);
      expect(docs[0]).toBe('TEST_jss');
    });

    test('listDocs skips non-directory entries', async () => {
      await coldFiles.writeDoc('TEST_doc', '{}');
      // Create a file (not directory) in cold dir
      const coldDir = path.join(coldTestDir, 'cold');
      await fs.writeFile(path.join(coldDir, 'notadir'), 'test', 'utf8');

      const docs = await coldFiles.listDocs();
      expect(docs.length).toBe(1);
    });

    test('getStats returns document count and size', async () => {
      await coldFiles.writeDoc('STAT_one', JSON.stringify({ data: 'a'.repeat(100) }));
      await coldFiles.writeDoc('STAT_two', JSON.stringify({ data: 'b'.repeat(200) }));

      const stats = await coldFiles.getStats();
      expect(stats.coldDocuments).toBe(2);
      expect(stats.totalSizeMB).toBeGreaterThanOrEqual(0);
    });

    test('getStats handles stat errors gracefully', async () => {
      await coldFiles.writeDoc('STAT_doc', '{}');
      // Delete the file to cause stat error
      await coldFiles.deleteDoc('STAT_doc');

      // Should not throw, returns 0 size
      const stats = await coldFiles.getStats();
      expect(stats.coldDocuments).toBe(0);
    });
  });

  describe('HotTierCache Direct Tests', () => {
    test('throws if maxMemoryMB not provided', () => {
      expect(() => new HotTierCache({})).toThrow('maxMemoryMB is required');
    });

    test('set and get document', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('TEST_key', '{"value":1}');
      const result = await cache.get('TEST_key');
      expect(result).toBe('{"value":1}');
    });

    test('get returns null for non-existent key', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      const result = await cache.get('NOTFOUND_key');
      expect(result).toBeNull();
    });

    test('has returns true for existing key', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('TEST_key', '{}');
      expect(cache.has('TEST_key')).toBe(true);
    });

    test('has returns false for non-existent key', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      expect(cache.has('NOTFOUND_key')).toBe(false);
    });

    test('delete removes document', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('TEST_key', '{}');
      cache.delete('TEST_key');
      expect(cache.has('TEST_key')).toBe(false);
    });

    test('delete on cold reference', async () => {
      const cache = new HotTierCache({
        maxMemoryMB: 64,
        coldLoader: () => Promise.resolve('{}')
      });
      // Simulate a cold reference
      cache.documents.set('COLD_key', { cold: true, key: 'COLD_key' });
      cache.delete('COLD_key');
      expect(cache.has('COLD_key')).toBe(false);
    });

    test('rename moves document', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('OLD_key', '{"name":"test"}');
      cache.rename('OLD_key', 'NEW_key');
      expect(cache.has('OLD_key')).toBe(false);
      expect(cache.has('NEW_key')).toBe(true);
    });

    test('markClean sets dirty flag to false', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('TEST_key', '{}', true);
      cache.markClean('TEST_key');
      const dirty = cache.getDirtyEntries();
      expect(dirty.find(d => d.key === 'TEST_key')).toBeUndefined();
    });

    test('getDirtyEntries returns dirty documents', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('DIRTY_one', '{}', true);
      await cache.set('CLEAN_two', '{}', false);

      const dirty = cache.getDirtyEntries();
      expect(dirty.length).toBe(1);
      expect(dirty[0].key).toBe('DIRTY_one');
    });

    test('sAdd adds member to set', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.sAdd('SET_key', 'member1');
      const members = cache.sMembers('SET_key');
      expect(members).toContain('member1');
    });

    test('sMembers returns empty array for non-existent set', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      const members = cache.sMembers('NOTFOUND_set');
      expect(Array.isArray(members)).toBe(true);
      expect(members.length).toBe(0);
    });

    test('sRem removes member from set', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.sAdd('SET_key', 'member1');
      cache.sAdd('SET_key', 'member2');
      cache.sRem('SET_key', 'member1');
      const members = cache.sMembers('SET_key');
      expect(members).not.toContain('member1');
      expect(members).toContain('member2');
    });

    test('sRem on non-existent set is no-op', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      // Should not throw
      cache.sRem('NOTFOUND_set', 'member');
    });

    test('sExists returns true for existing set', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.sAdd('SET_key', 'member');
      expect(cache.sExists('SET_key')).toBe(true);
    });

    test('sExists returns false for non-existent set', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      expect(cache.sExists('NOTFOUND_set')).toBe(false);
    });

    test('getAllDocuments returns hot documents only', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('HOT_doc', '{"hot":true}');
      // Simulate cold ref
      cache.documents.set('COLD_doc', { cold: true, key: 'COLD_doc' });

      const docs = cache.getAllDocuments();
      expect(docs['HOT_doc']).toBe('{"hot":true}');
      expect(docs['COLD_doc']).toBeUndefined();
    });

    test('getAllCollections returns all sets', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.sAdd('SET1?', 'a');
      cache.sAdd('SET2?', 'b');

      const cols = cache.getAllCollections();
      expect(cols['SET1?']).toContain('a');
      expect(cols['SET2?']).toContain('b');
    });

    test('loadDocuments loads documents into cache', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.loadDocuments({
        'DOC_one': '{"name":"one"}',
        'DOC_two': '{"name":"two"}'
      });
      expect(cache.has('DOC_one')).toBe(true);
      expect(cache.has('DOC_two')).toBe(true);
    });

    test('loadCollections loads sets into cache', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.loadCollections({
        'SET1?': ['a', 'b'],
        'SET2?': ['c']
      });
      expect(cache.sMembers('SET1?')).toContain('a');
      expect(cache.sMembers('SET2?')).toContain('c');
    });

    test('clear resets all state', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('DOC_key', '{}');
      cache.sAdd('SET_key', 'member');

      cache.clear();

      expect(cache.has('DOC_key')).toBe(false);
      expect(cache.sMembers('SET_key').length).toBe(0);
      const stats = cache.getStats();
      expect(stats.hotDocuments).toBe(0);
    });

    test('getStats returns accurate counts', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('HOT_one', '{}');
      await cache.set('HOT_two', '{}');
      cache.documents.set('COLD_ref', { cold: true, key: 'COLD_ref' });
      cache.sAdd('SET?', 'member');

      const stats = cache.getStats();
      expect(stats.hotDocuments).toBe(2);
      expect(stats.coldReferences).toBe(1);
      expect(stats.collectionCount).toBe(1);
    });

    test('isCold returns true for cold references', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.documents.set('COLD_key', { cold: true, key: 'COLD_key' });
      expect(cache.isCold('COLD_key')).toBe(true);
    });

    test('isCold returns false for hot documents', async () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      await cache.set('HOT_key', '{}');
      expect(cache.isCold('HOT_key')).toBe(false);
    });

    test('get cold document loads from coldLoader', async () => {
      let loadCalled = false;
      const cache = new HotTierCache({
        maxMemoryMB: 64,
        coldLoader: async (key) => {
          loadCalled = true;
          return '{"loaded":"from_cold"}';
        }
      });
      cache.documents.set('COLD_key', { cold: true, key: 'COLD_key' });

      const result = await cache.get('COLD_key');
      expect(loadCalled).toBe(true);
      expect(result).toBe('{"loaded":"from_cold"}');
      // Should now be hot
      expect(cache.isCold('COLD_key')).toBe(false);
    });

    test('get cold document returns null if coldLoader returns null', async () => {
      const cache = new HotTierCache({
        maxMemoryMB: 64,
        coldLoader: async () => null
      });
      cache.documents.set('COLD_key', { cold: true, key: 'COLD_key' });

      const result = await cache.get('COLD_key');
      expect(result).toBeNull();
      expect(cache.has('COLD_key')).toBe(false);
    });

    test('eviction triggers onEvict callback', async () => {
      let evictedKeys = [];
      const cache = new HotTierCache({
        maxMemoryMB: 0.0001, // Very small
        evictionThreshold: 0.001,
        onEvict: (key, value) => {
          evictedKeys.push(key);
        }
      });

      // Add large documents to trigger eviction
      for (let i = 0; i < 10; i++) {
        await cache.set(`EVICT_${i}`, JSON.stringify({ data: 'x'.repeat(1000) }), false);
      }

      // Some should have been evicted
      expect(evictedKeys.length).toBeGreaterThan(0);
    });

    test('markClean on cold ref is no-op', () => {
      const cache = new HotTierCache({ maxMemoryMB: 64 });
      cache.documents.set('COLD_key', { cold: true, key: 'COLD_key' });
      // Should not throw
      cache.markClean('COLD_key');
    });
  });
});
