/**
 * @file Exercise `storage/index.js` factory branches, `storage/interface.js`
 * validation (`validateConfig` from `./storage`), and `client/index.js`
 * env/options paths using **`openLocalDatabase`**, **`bri.connect`**, and real
 *
 * Operators set `BRI_DATA_DIR` / `BRI_MAX_MEMORY_MB` or pass `storeConfig`;
 * tests observe the resulting tree (`wal`, `data`) and branch coverage paths
 * Dynamic `import()` after `jest.resetModules()` flushes module caches between
 * `_store.config` is asserted sparingly because the facade documents that hook
 * for advanced inspection of resolved adapter settings.
 */

import {
  describe, test, expect, beforeEach, afterEach, jest
} from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { openLocalDatabase } from '../helpers/open-database.js';
const root = path.join(os.tmpdir(), `bri-pub-branch-${Math.random().toString(36).slice(2)}`);

describe('storage/index.js createStore (./storage export)', () => {
  test('bundled defaults apply when called with {} (config falsy)', async () => {
    const { createStore } = await import('../../src/storage/index.js');
    const store = await createStore({});
    expect(store.config.dataDir || store.config.data_dir).toBeTruthy();
    expect(store.config.maxMemoryMB).toBeGreaterThan(0);
    await store.disconnect();
  });

  test('bundled defaults apply when called with zero arguments', async () => {
    const { createStore } = await import('../../src/storage/index.js');
    const store = await createStore();
    expect(store.config.maxMemoryMB).toBeGreaterThan(0);
    await store.disconnect();
  });

  test('explicit options.config sets data dir and budget', async () => {
    const { createStore } = await import('../../src/storage/index.js');
    const dir = path.join(root, 'explicit-store');
    await fs.mkdir(dir, { recursive: true });
    const store = await createStore({
      config: { dataDir: dir, maxMemoryMB: 41 }
    });
    expect(store.config.dataDir).toBe(dir);
    expect(store.config.maxMemoryMB).toBe(41);
    await store.disconnect();
  });

  test('config key explicitly null restores bundled defaults path', async () => {
    const { createStore } = await import('../../src/storage/index.js');
    const store = await createStore({
      config: null
    });
    expect(store.config.dataDir).toBe('./data');
    expect(store.config.maxMemoryMB).toBe(256);
    await store.disconnect();
  });
});

describe('storage/interface.js via validateConfig (exported from ./storage)', () => {
  test('enforce maxMemoryMB rules', async () => {
    const { validateConfig } = await import('../../src/storage/index.js');

    expect(() => validateConfig({ dataDir: '/' })).toThrow(/maxMemoryMB is required/i);
    expect(() => validateConfig({ dataDir: '/', maxMemoryMB: '12' }))
      .toThrow(/must be a number/i);
    expect(() => validateConfig({ dataDir: '/', maxMemoryMB: true }))
      .toThrow(/must be a number/i);
    expect(() => validateConfig({ dataDir: '/', maxMemoryMB: -1 })).toThrow(/positive/i);

    expect(validateConfig({ dataDir: '/', maxMemoryMB: 10 }).encryption.enabled).toBe(false);
    expect(() =>
      validateConfig({
        dataDir: '/',
        maxMemoryMB: 10,
        encryption: {
          enabled: true,
          algorithm: 'not-a-real-cipher',
          keyProvider: 'env'
        }
      })
    ).toThrow(/Unsupported encryption algorithm/i);
    expect(() =>
      validateConfig({
        dataDir: '/',
        maxMemoryMB: 10,
        encryption: {
          enabled: true,
          algorithm: 'aes-256-gcm',
          keyProvider: 'no-such-provider'
        }
      })
    ).toThrow(/Unknown key provider/i);

    expect(() =>
      validateConfig({
        dataDir: '/',
        maxMemoryMB: 11,
        encryption: {
          enabled: true,
          algorithm: 'aes-256-gcm',
          keyProvider: 'remote',
          keyProviderConfig: {}
        }
      })
    ).toThrow(/endpoint/i);

    expect(validateConfig({
      dataDir: '/',
      maxMemoryMB: 13,
      encryption: {
        enabled: true,
        algorithm: 'aes-256-gcm',
        keyProvider: 'remote',
        keyProviderConfig: { endpoint: 'https://keys.example.invalid/v1/current' }
      }
    }).encryption.keyProvider).toBe('remote');

    expect(validateConfig({
      dataDir: '/',
      maxMemoryMB: 12,
      encryption: { enabled: false, algorithm: 'aes-256-gcm' }
    }).encryption.enabled).toBe(false);
  });
});

describe('Env + storeConfig resolution (openLocalDatabase)', () => {
  let snapshot;
  /** @type {import('../../src/client/index.js')|null} */
  let db;

  beforeEach(() => {
    snapshot = {
      data: process.env.BRI_DATA_DIR,
      mem: process.env.BRI_MAX_MEMORY_MB
    };
    jest.resetModules();
    db = null;
  });

  afterEach(async () => {
    if (db?.disconnect) await db.disconnect();
    if (snapshot.data !== undefined) process.env.BRI_DATA_DIR = snapshot.data;
    else delete process.env.BRI_DATA_DIR;
    if (snapshot.mem !== undefined) process.env.BRI_MAX_MEMORY_MB = snapshot.mem;
    else delete process.env.BRI_MAX_MEMORY_MB;
  });

  test('omit storeConfig: WAL appears under process.env.BRI_DATA_DIR tree', async () => {
    const dir = path.join(root, 'env-branch');
    await fs.mkdir(dir, { recursive: true });
    delete process.env.BRI_DATA_DIR;
    delete process.env.BRI_MAX_MEMORY_MB;
    process.env.BRI_DATA_DIR = dir;
    process.env.BRI_MAX_MEMORY_MB = '96';

    db = await openLocalDatabase({});
    db.schema('probeDoc', { token: { type: String, required: true } });
    await db.add.probeDoc({ token: 't' });

    const top = await fs.readdir(dir);
    expect(top).toContain('wal');
    await db.disconnect();
    db = null;
  });

  test('explicit storeConfig anchors data under given dir when env names another tree', async () => {
    const dir = path.join(root, 'explicit-branch');
    const decoyDir = path.join(root, `decoy-${Math.random()}`);
    await fs.mkdir(dir, { recursive: true });

    delete process.env.BRI_DATA_DIR;
    process.env.BRI_DATA_DIR = decoyDir;

    db = await openLocalDatabase({
      storeConfig: {
        dataDir: dir,
        maxMemoryMB: 32
      }
    });

    db.schema('probeDoc2', { token: { type: String, required: true } });
    await db.add.probeDoc2({ token: 'x' });

    expect((await fs.readdir(dir))).toContain('wal');
    await expect(fs.access(decoyDir)).rejects.toThrow();
    await db.disconnect();
    db = null;
  });

  test('explicit storeType inhouse binds the same backend as default', async () => {
    const dir = path.join(root, 'inhouse-explicit-type');
    await fs.mkdir(dir, { recursive: true });

    delete process.env.BRI_DATA_DIR;
    delete process.env.BRI_MAX_MEMORY_MB;

    db = await openLocalDatabase({
      storeType: 'inhouse',
      storeConfig: {
        dataDir: dir,
        maxMemoryMB: 44
      }
    });

    db.schema('probeDoc3', { token: { type: String, required: true } });
    await db.add.probeDoc3({ token: 'z' });

    expect((await fs.readdir(dir))).toContain('wal');
    await db.disconnect();
    db = null;
  });

  test('create(undefined) behaves like implicit defaults bundle', async () => {
    const dir = path.join(root, 'undefined-options');
    await fs.mkdir(dir, { recursive: true });

    delete process.env.BRI_DATA_DIR;
    process.env.BRI_DATA_DIR = dir;
    delete process.env.BRI_MAX_MEMORY_MB;

    db = await openLocalDatabase(undefined);
    db.schema('probeUndefined', { token: { type: String, required: true } });
    await db.add.probeUndefined({ token: 'ok' });

    expect((await fs.readdir(dir))).toContain('wal');
    await db.disconnect();
    db = null;
  });

  test('invalid BRI_MAX_MEMORY_MB parses to NaN and falls back to 256 MiB cap', async () => {
    const dir = path.join(root, 'bad-mem-env');
    await fs.mkdir(dir, { recursive: true });

    delete process.env.BRI_DATA_DIR;
    process.env.BRI_DATA_DIR = dir;
    process.env.BRI_MAX_MEMORY_MB = 'not-parseable';

    db = await openLocalDatabase({});
    expect(db._store.config.maxMemoryMB).toBe(256);

    db.schema('probeBadMem', { token: { type: String, required: true } });
    await db.add.probeBadMem({ token: 'v' });

    expect((await fs.readdir(dir))).toContain('wal');
    await db.disconnect();
    db = null;
  });

  test('when BRI_DATA_DIR is unset WAL lands under cwd-relative ./data', async () => {
    const isolate = path.join(root, 'cwd-fallback-data-dir');
    await fs.mkdir(isolate, { recursive: true });
    const back = process.cwd();

    delete process.env.BRI_DATA_DIR;
    delete process.env.BRI_MAX_MEMORY_MB;

    process.chdir(isolate);
    jest.resetModules();
    try {
      db = await openLocalDatabase({});
      db.schema('probeRelative', { token: { type: String, required: true } });
      await db.add.probeRelative({ token: 'r' });

      expect((await fs.readdir(isolate))).toContain('data');
      expect((await fs.readdir(path.join(isolate, 'data')))).toContain('wal');
      await db.disconnect();
      db = null;
    } finally {
      process.chdir(back);
    }
  });
});
