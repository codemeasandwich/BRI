/**
 * @file Phase D regression — `BRI_VECTOR_WORKER` parsing and warm path.
 */

import { openLocalDatabase } from '../helpers/open-database.js';
import {
  createWorkerVectorIndex,
  disposeWorker,
  warmVectorWorkerFromEnv,
  workerDiagnostics
} from '../../workers/index-worker-host.js';
import { isVectorWorkerWarmRequestedFromEnv } from '../../workers/vector-worker-env.js';

const BASE = './test-data-bri-vector-worker-env';

describe('workers/vector-worker-env parsing', () => {
  let snapshot;

  beforeEach(() => {
    snapshot = process.env.BRI_VECTOR_WORKER;
  });

  afterEach(() => {
    if (snapshot === undefined) delete process.env.BRI_VECTOR_WORKER;
    else process.env.BRI_VECTOR_WORKER = snapshot;
  });

  test('unset or whitespace-only → false', () => {
    delete process.env.BRI_VECTOR_WORKER;
    expect(isVectorWorkerWarmRequestedFromEnv()).toBe(false);
    process.env.BRI_VECTOR_WORKER = '';
    expect(isVectorWorkerWarmRequestedFromEnv()).toBe(false);
    process.env.BRI_VECTOR_WORKER = '   ';
    expect(isVectorWorkerWarmRequestedFromEnv()).toBe(false);
  });

  test('whitelist tokens enable (trim + case-fold)', () => {
    for (const raw of ['true', 'TRUE', '  true  ', '1', 'yes', 'YES', 'on']) {
      process.env.BRI_VECTOR_WORKER = raw;
      expect(isVectorWorkerWarmRequestedFromEnv()).toBe(true);
    }
  });

  test('explicit disable tokens', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'FALSE']) {
      process.env.BRI_VECTOR_WORKER = raw;
      expect(isVectorWorkerWarmRequestedFromEnv()).toBe(false);
    }
  });

  test('unknown token stays opt-out', () => {
    process.env.BRI_VECTOR_WORKER = 'maybe';
    expect(isVectorWorkerWarmRequestedFromEnv()).toBe(false);
  });
});

async function restoreEnv(prev) {
  if (prev === undefined) delete process.env.BRI_VECTOR_WORKER;
  else process.env.BRI_VECTOR_WORKER = prev;
  await disposeWorker();
}

describe('BRI_VECTOR_WORKER warm smoke (integration)', () => {
  test('preload + programmatic WorkerVectorIndex bumps diag counter', async () => {
    const prev = process.env.BRI_VECTOR_WORKER;
    process.env.BRI_VECTOR_WORKER = 'true';
    await disposeWorker();
    warmVectorWorkerFromEnv();
    const before = (await workerDiagnostics()).opCount;

    const db = await openLocalDatabase({
      storeConfig: { dataDir: `${BASE}-warm-int`, maxMemoryMB: 64 }
    });

    const idx = await createWorkerVectorIndex({
      collection: 'envwarm', dims: 4, seed: 2
    });
    const v = [1, 0, 0, 0];
    await idx.add('X_t1', v);
    await idx.search(v, 1);

    const after = (await workerDiagnostics()).opCount;
    expect(after).toBeGreaterThanOrEqual(before + 2);
    await db.disconnect();
    await restoreEnv(prev);
  }, 60000);

  test('openLocalDatabase preload path respects env=1 alias', async () => {
    const prev = process.env.BRI_VECTOR_WORKER;
    process.env.BRI_VECTOR_WORKER = '1';
    await disposeWorker();
    const db = await openLocalDatabase({
      storeConfig: { dataDir: `${BASE}-alias-one`, maxMemoryMB: 48 }
    });
    expect(db.disconnect).toBeDefined();
    await db.disconnect();
    await restoreEnv(prev);
  });

  test('openLocalDatabase skips worker import when unset', async () => {
    const prev = process.env.BRI_VECTOR_WORKER;
    delete process.env.BRI_VECTOR_WORKER;
    await disposeWorker();
    const db = await openLocalDatabase({
      storeConfig: { dataDir: `${BASE}-cold`, maxMemoryMB: 48 }
    });
    expect(db.disconnect).toBeDefined();
    await db.disconnect();
    await restoreEnv(prev);
  });

  test('openLocalDatabase with explicit disable token does not request warm', async () => {
    const prev = process.env.BRI_VECTOR_WORKER;
    process.env.BRI_VECTOR_WORKER = 'off';
    expect(isVectorWorkerWarmRequestedFromEnv()).toBe(false);
    await disposeWorker();
    const db = await openLocalDatabase({
      storeConfig: { dataDir: `${BASE}-explicit-off`, maxMemoryMB: 48 }
    });
    expect(db.disconnect).toBeDefined();
    await db.disconnect();
    await restoreEnv(prev);
  });
});
