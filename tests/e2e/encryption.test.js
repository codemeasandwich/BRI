/**
 * E2E Encryption Tests
 * Tests: AES-256-GCM encryption, key management, encrypted persistence
 */

import { createDB } from '../../client/index.js';
import { encrypt, decrypt, KEY_SIZE, IV_SIZE, TAG_SIZE } from '../../crypto/aes-gcm.js';
import { KeyManager } from '../../crypto/key-manager.js';
import { EnvKeyProvider } from '../../crypto/providers/env.js';
import { FileKeyProvider } from '../../crypto/providers/file.js';
import { RemoteKeyProvider } from '../../crypto/providers/remote.js';
import {
  EncryptionError,
  KeyUnavailableError,
  InvalidKeyError,
  AuthenticationError,
  InsecureKeyFileError
} from '../../crypto/errors.js';
import { WALWriter } from '../../storage/wal/writer.js';
import { WALReader } from '../../storage/wal/reader.js';
import { createSetEntry, deserializeEntry, serializeEntryEncrypted } from '../../storage/wal/entry.js';
import { SnapshotManager } from '../../storage/snapshot/manager.js';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const TEST_DATA_DIR = './test-data-encryption';
const TEST_KEY = crypto.randomBytes(32); // Random 32-byte key for testing
const TEST_KEY_HEX = TEST_KEY.toString('hex');

describe('AES-256-GCM Encryption', () => {
  describe('encrypt()', () => {
    test('encrypts data with correct format', () => {
      const plaintext = Buffer.from('Hello, World!');
      const encrypted = encrypt(plaintext, TEST_KEY);

      // Format: IV (12) + AuthTag (16) + Ciphertext
      expect(encrypted.length).toBe(IV_SIZE + TAG_SIZE + plaintext.length);
    });

    test('produces different ciphertext for same plaintext (random IV)', () => {
      const plaintext = Buffer.from('Same message');
      const encrypted1 = encrypt(plaintext, TEST_KEY);
      const encrypted2 = encrypt(plaintext, TEST_KEY);

      // IVs should be different
      const iv1 = encrypted1.subarray(0, IV_SIZE);
      const iv2 = encrypted2.subarray(0, IV_SIZE);
      expect(iv1.equals(iv2)).toBe(false);
    });

    test('throws on invalid key length', () => {
      const plaintext = Buffer.from('test');
      const shortKey = Buffer.alloc(16);

      expect(() => encrypt(plaintext, shortKey)).toThrow(InvalidKeyError);
    });

    test('includes AAD in authentication', () => {
      const plaintext = Buffer.from('test data');
      const aad = Buffer.from('additional data');
      const encrypted = encrypt(plaintext, TEST_KEY, aad);

      // Should decrypt fine with correct AAD
      const decrypted = decrypt(encrypted, TEST_KEY, aad);
      expect(decrypted.equals(plaintext)).toBe(true);

      // Should fail with wrong AAD
      expect(() => decrypt(encrypted, TEST_KEY, Buffer.from('wrong aad'))).toThrow(AuthenticationError);
    });
  });

  describe('decrypt()', () => {
    test('decrypts encrypted data correctly', () => {
      const plaintext = Buffer.from('Secret message');
      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    test('throws on wrong key', () => {
      const plaintext = Buffer.from('test');
      const encrypted = encrypt(plaintext, TEST_KEY);
      const wrongKey = crypto.randomBytes(32);

      expect(() => decrypt(encrypted, wrongKey)).toThrow(AuthenticationError);
    });

    test('throws on tampered ciphertext', () => {
      const plaintext = Buffer.from('test');
      const encrypted = encrypt(plaintext, TEST_KEY);

      // Tamper with ciphertext
      encrypted[encrypted.length - 1] ^= 0xff;

      expect(() => decrypt(encrypted, TEST_KEY)).toThrow(AuthenticationError);
    });

    test('throws on truncated data', () => {
      const truncated = Buffer.alloc(10); // Too short

      expect(() => decrypt(truncated, TEST_KEY)).toThrow(AuthenticationError);
    });

    test('throws on invalid key length', () => {
      const encrypted = encrypt(Buffer.from('test'), TEST_KEY);
      const shortKey = Buffer.alloc(16);

      expect(() => decrypt(encrypted, shortKey)).toThrow(InvalidKeyError);
    });
  });

  describe('round-trip with various data types', () => {
    test('handles empty data', () => {
      const plaintext = Buffer.alloc(0);
      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    test('handles large data', () => {
      const plaintext = crypto.randomBytes(1024 * 1024); // 1MB
      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    test('handles JSON data', () => {
      const obj = { name: 'test', value: 42, nested: { deep: true } };
      const plaintext = Buffer.from(JSON.stringify(obj));
      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);
      expect(JSON.parse(decrypted.toString())).toEqual(obj);
    });

    test('handles Unicode data', () => {
      const plaintext = Buffer.from('Hello 世界 🌍 مرحبا');
      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);
      expect(decrypted.toString()).toBe('Hello 世界 🌍 مرحبا');
    });
  });
});

describe('Key Providers', () => {
  describe('EnvKeyProvider', () => {
    const originalEnv = process.env.BRI_ENCRYPTION_KEY;

    afterEach(() => {
      if (originalEnv) {
        process.env.BRI_ENCRYPTION_KEY = originalEnv;
      } else {
        delete process.env.BRI_ENCRYPTION_KEY;
      }
    });

    test('fetches key from environment variable', async () => {
      process.env.BRI_ENCRYPTION_KEY = TEST_KEY_HEX;

      const provider = new EnvKeyProvider();
      const result = await provider.fetchKey();

      expect(result.key.equals(TEST_KEY)).toBe(true);
      expect(result.keyId).toBe('env-static');
    });

    test('uses custom env var name', async () => {
      process.env.CUSTOM_KEY = TEST_KEY_HEX;

      const provider = new EnvKeyProvider({ envVar: 'CUSTOM_KEY' });
      const result = await provider.fetchKey();

      expect(result.key.equals(TEST_KEY)).toBe(true);

      delete process.env.CUSTOM_KEY;
    });

    test('throws if env var not set', async () => {
      delete process.env.BRI_ENCRYPTION_KEY;

      const provider = new EnvKeyProvider();
      await expect(provider.fetchKey()).rejects.toThrow(KeyUnavailableError);
    });

    test('throws if key is invalid hex', async () => {
      process.env.BRI_ENCRYPTION_KEY = 'not-valid-hex';

      const provider = new EnvKeyProvider();
      await expect(provider.fetchKey()).rejects.toThrow(InvalidKeyError);
    });

    test('throws if key is wrong length', async () => {
      process.env.BRI_ENCRYPTION_KEY = 'abcd'; // Too short

      const provider = new EnvKeyProvider();
      await expect(provider.fetchKey()).rejects.toThrow(InvalidKeyError);
    });
  });

  describe('FileKeyProvider', () => {
    const KEY_FILE_DIR = './test-key-file';
    const KEY_FILE_PATH = path.join(KEY_FILE_DIR, 'test.key');

    beforeEach(async () => {
      await fs.mkdir(KEY_FILE_DIR, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(KEY_FILE_DIR, { recursive: true, force: true }).catch(() => {});
    });

    test('reads binary key file', async () => {
      await fs.writeFile(KEY_FILE_PATH, TEST_KEY);
      await fs.chmod(KEY_FILE_PATH, 0o600);

      const provider = new FileKeyProvider({ keyPath: KEY_FILE_PATH });
      const result = await provider.fetchKey();

      expect(result.key.equals(TEST_KEY)).toBe(true);
    });

    test('reads hex-encoded key file', async () => {
      await fs.writeFile(KEY_FILE_PATH, TEST_KEY_HEX);
      await fs.chmod(KEY_FILE_PATH, 0o600);

      const provider = new FileKeyProvider({ keyPath: KEY_FILE_PATH });
      const result = await provider.fetchKey();

      expect(result.key.equals(TEST_KEY)).toBe(true);
    });

    test('throws if file not found', async () => {
      const provider = new FileKeyProvider({ keyPath: '/nonexistent/key.file' });
      await expect(provider.fetchKey()).rejects.toThrow(KeyUnavailableError);
    });

    test('throws if file has wrong permissions', async () => {
      await fs.writeFile(KEY_FILE_PATH, TEST_KEY);
      await fs.chmod(KEY_FILE_PATH, 0o644); // World-readable

      const provider = new FileKeyProvider({ keyPath: KEY_FILE_PATH });
      await expect(provider.fetchKey()).rejects.toThrow(InsecureKeyFileError);
    });

    test('skips permission check if disabled', async () => {
      await fs.writeFile(KEY_FILE_PATH, TEST_KEY);
      await fs.chmod(KEY_FILE_PATH, 0o644);

      const provider = new FileKeyProvider({
        keyPath: KEY_FILE_PATH,
        checkPermissions: false
      });
      const result = await provider.fetchKey();

      expect(result.key.equals(TEST_KEY)).toBe(true);
    });

    test('throws if key file has invalid content', async () => {
      await fs.writeFile(KEY_FILE_PATH, 'invalid');
      await fs.chmod(KEY_FILE_PATH, 0o600);

      const provider = new FileKeyProvider({ keyPath: KEY_FILE_PATH });
      await expect(provider.fetchKey()).rejects.toThrow(InvalidKeyError);
    });
  });

  describe('RemoteKeyProvider', () => {
    test('throws if endpoint not configured', () => {
      expect(() => new RemoteKeyProvider({})).toThrow('requires endpoint');
    });

    test('retries on failure', async () => {
      const provider = new RemoteKeyProvider({
        endpoint: 'https://nonexistent.invalid',
        retryAttempts: 2,
        retryDelayMs: 10,
        timeout: 100
      });

      await expect(provider.fetchKey()).rejects.toThrow(/Failed to fetch key after 2 attempts/);
    });
  });
});

describe('KeyManager', () => {
  const originalEnv = process.env.BRI_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.BRI_ENCRYPTION_KEY = TEST_KEY_HEX;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.BRI_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.BRI_ENCRYPTION_KEY;
    }
  });

  test('initializes with env provider', async () => {
    const manager = new KeyManager({ keyProvider: 'env' });
    await manager.initialize();

    expect(manager.getKey().equals(TEST_KEY)).toBe(true);
    expect(manager.getKeyId()).toBe('env-static');

    await manager.close();
  });

  test('throws if not initialized', () => {
    const manager = new KeyManager({ keyProvider: 'env' });
    expect(() => manager.getKey()).toThrow(KeyUnavailableError);
  });

  test('close() clears key from memory', async () => {
    const manager = new KeyManager({ keyProvider: 'env' });
    await manager.initialize();

    const keyBefore = manager.getKey();
    await manager.close();

    // Key should be overwritten with random data
    expect(keyBefore.equals(TEST_KEY)).toBe(false);
    expect(manager.initialized).toBe(false);
  });

  test('double initialize is no-op', async () => {
    const manager = new KeyManager({ keyProvider: 'env' });
    await manager.initialize();
    await manager.initialize(); // Should not throw

    await manager.close();
  });
});

describe('Encrypted WAL', () => {
  const WAL_DIR = path.join(TEST_DATA_DIR, 'wal');

  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(WAL_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('writes encrypted entries', async () => {
    const writer = new WALWriter(WAL_DIR, {
      fsyncMode: 'always',
      encryptionKey: TEST_KEY
    });
    await writer.init();

    await writer.append(createSetEntry('TEST_key', '{"value":"secret"}'));
    await writer.close();

    // Read raw file - should not contain plaintext
    const segments = await fs.readdir(WAL_DIR);
    const content = await fs.readFile(path.join(WAL_DIR, segments[0]), 'utf8');

    expect(content).not.toContain('"secret"');
    expect(content).not.toContain('TEST_key'); // Key is in plaintext but value is encrypted
  });

  test('reads encrypted entries', async () => {
    // Write encrypted
    const writer = new WALWriter(WAL_DIR, {
      fsyncMode: 'always',
      encryptionKey: TEST_KEY
    });
    await writer.init();
    await writer.append(createSetEntry('TEST_key', '{"value":"secret"}'));
    await writer.close();

    // Read encrypted
    const reader = new WALReader(WAL_DIR, { encryptionKey: TEST_KEY });
    const entries = [];
    for await (const entry of reader.readEntries(0)) {
      entries.push(entry);
    }

    expect(entries.length).toBe(1);
    expect(entries[0].target).toBe('TEST_key');
    expect(entries[0].value).toBe('{"value":"secret"}');
  });

  test('fails to read with wrong key', async () => {
    // Write encrypted
    const writer = new WALWriter(WAL_DIR, {
      fsyncMode: 'always',
      encryptionKey: TEST_KEY
    });
    await writer.init();
    await writer.append(createSetEntry('TEST_key', '{}'));
    await writer.close();

    // Try to read with wrong key
    const wrongKey = crypto.randomBytes(32);
    const reader = new WALReader(WAL_DIR, { encryptionKey: wrongKey });

    const entries = [];
    for await (const entry of reader.readEntries(0)) {
      entries.push(entry);
    }

    // Entry should be skipped due to decryption error
    expect(entries.length).toBe(0);
  });

  test('maintains pointer chain with encryption', async () => {
    const writer = new WALWriter(WAL_DIR, {
      fsyncMode: 'always',
      encryptionKey: TEST_KEY
    });
    await writer.init();

    await writer.append(createSetEntry('K1', '{}'));
    await writer.append(createSetEntry('K2', '{}'));
    await writer.append(createSetEntry('K3', '{}'));
    await writer.close();

    const reader = new WALReader(WAL_DIR, { encryptionKey: TEST_KEY });
    const result = await reader.verifyIntegrity();

    expect(result.valid).toBe(true);
    expect(result.totalLines).toBe(3);
  });

  test('replay works with encryption', async () => {
    const writer = new WALWriter(WAL_DIR, {
      fsyncMode: 'always',
      encryptionKey: TEST_KEY
    });
    await writer.init();

    await writer.append(createSetEntry('K1', '{"v":1}'));
    await writer.append(createSetEntry('K2', '{"v":2}'));
    await writer.close();

    const reader = new WALReader(WAL_DIR, { encryptionKey: TEST_KEY });
    const setOps = [];
    await reader.replay(0, {
      onSet: (key, value) => setOps.push({ key, value }),
      onDelete: () => {},
      onRename: () => {},
      onSAdd: () => {},
      onSRem: () => {}
    });

    expect(setOps.length).toBe(2);
    expect(setOps[0].key).toBe('K1');
    expect(setOps[1].key).toBe('K2');
  });
});

describe('Encrypted Snapshots', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('creates encrypted snapshot', async () => {
    const manager = new SnapshotManager(TEST_DATA_DIR, { encryptionKey: TEST_KEY });

    await manager.create({
      version: 2,
      walLine: 100,
      documents: { 'TEST_abc': { secret: 'value' } },
      collections: {}
    });

    // Read raw file
    const content = await fs.readFile(path.join(TEST_DATA_DIR, 'snapshot.jss'), 'utf8');

    expect(content).not.toContain('secret');
    expect(content).not.toContain('value');
  });

  test('loads encrypted snapshot', async () => {
    const manager = new SnapshotManager(TEST_DATA_DIR, { encryptionKey: TEST_KEY });

    await manager.create({
      version: 2,
      walLine: 100,
      documents: { 'TEST_abc': { secret: 'value' } },
      collections: { 'TEST?': ['abc'] }
    });

    const loaded = await manager.loadLatest();

    expect(loaded.version).toBe(2);
    expect(loaded.walLine).toBe(100);
    expect(loaded.documents['TEST_abc'].secret).toBe('value');
  });

  test('getStats works with encryption', async () => {
    const manager = new SnapshotManager(TEST_DATA_DIR, { encryptionKey: TEST_KEY });

    await manager.create({
      version: 2,
      walLine: 50,
      documents: {},
      collections: {}
    });

    const stats = await manager.getStats();

    expect(stats.exists).toBe(true);
    expect(stats.walLine).toBe(50);
  });

  test('fails to load with wrong key', async () => {
    // Create with TEST_KEY
    const manager1 = new SnapshotManager(TEST_DATA_DIR, { encryptionKey: TEST_KEY });
    await manager1.create({
      version: 2,
      walLine: 100,
      documents: {},
      collections: {}
    });

    // Try to load with wrong key
    const wrongKey = crypto.randomBytes(32);
    const manager2 = new SnapshotManager(TEST_DATA_DIR, { encryptionKey: wrongKey });

    const result = await manager2.loadLatest();
    expect(result).toBeNull(); // Should return null on error
  });
});

describe('End-to-End Encrypted Persistence', () => {
  const originalEnv = process.env.BRI_ENCRYPTION_KEY;

  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    process.env.BRI_ENCRYPTION_KEY = TEST_KEY_HEX;
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    if (originalEnv) {
      process.env.BRI_ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.BRI_ENCRYPTION_KEY;
    }
  });

  test('data persists encrypted and recovers', async () => {
    // Create DB with encryption
    const db1 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });

    // Add some data
    const item = await db1.add.encrypted({ secret: 'classified', value: 42 });
    const itemId = item.$ID;

    await db1._store.createSnapshot();
    await db1.disconnect();

    // Verify WAL file is encrypted
    const walFiles = await fs.readdir(path.join(TEST_DATA_DIR, 'wal'));
    const walContent = await fs.readFile(path.join(TEST_DATA_DIR, 'wal', walFiles[0]), 'utf8');
    expect(walContent).not.toContain('classified');

    // Verify snapshot is encrypted
    const snapshotContent = await fs.readFile(path.join(TEST_DATA_DIR, 'snapshot.jss'), 'utf8');
    expect(snapshotContent).not.toContain('classified');

    // Reconnect and verify data recovers
    const db2 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });

    const recovered = await db2.get.encrypted(itemId);
    expect(recovered).not.toBeNull();
    expect(recovered.secret).toBe('classified');
    expect(recovered.value).toBe(42);

    await db2.disconnect();
  });

  test('WAL replay works with encryption after snapshot', async () => {
    const db1 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });

    await db1.add.walenc({ name: 'Before' });
    await db1._store.createSnapshot();

    await db1.add.walenc({ name: 'After' });
    // No snapshot after - will need WAL replay
    await db1.disconnect();

    const db2 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });

    const items = await db2.get.walencS();
    expect(items.length).toBe(2);

    await db2.disconnect();
  });

  test('fails to start without encryption key', async () => {
    // First create encrypted data
    const db1 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });
    await db1.add.test({ value: 1 });
    await db1.disconnect();

    // Remove the key
    delete process.env.BRI_ENCRYPTION_KEY;

    // Should fail to start
    await expect(createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    })).rejects.toThrow(KeyUnavailableError);
  });

  test('updates persist with encryption', async () => {
    const db1 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });

    const item = await db1.add.encupdate({ counter: 0 });
    item.counter = 100;
    await item.save();

    await db1._store.createSnapshot();
    await db1.disconnect();

    const db2 = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'env'
        }
      }
    });

    const recovered = await db2.get.encupdate(item.$ID);
    expect(recovered.counter).toBe(100);

    await db2.disconnect();
  });
});

describe('serializeEntryEncrypted', () => {
  test('produces encrypted output', () => {
    const entry = createSetEntry('KEY', '{"secret":"value"}');
    const line = serializeEntryEncrypted(entry, null, TEST_KEY);

    const parts = line.split('|');
    expect(parts.length).toBe(3);

    // Entry part should be base64-encoded encrypted data
    const entryPart = parts[2];
    expect(() => JSON.parse(entryPart)).toThrow(); // Not valid JSON
    expect(() => Buffer.from(entryPart, 'base64')).not.toThrow(); // Valid base64
  });

  test('can be decrypted by deserializeEntry', () => {
    const entry = createSetEntry('KEY', '{"secret":"value"}');
    const line = serializeEntryEncrypted(entry, null, TEST_KEY);

    const parsed = deserializeEntry(line, TEST_KEY);

    expect(parsed.action).toBe('SET');
    expect(parsed.target).toBe('KEY');
    expect(parsed.value).toBe('{"secret":"value"}');
  });
});
