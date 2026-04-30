/**
 * @file Vector worker preload must survive failed dynamic import of the Worker host.
 */

import fs from 'fs/promises';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const DATA = './test-data-bri-preload-fail-host';

describe('openLocalDatabase vector worker host load failure', () => {
  let envSnap;

  beforeEach(() => {
    envSnap = process.env.BRI_VECTOR_WORKER;
    jest.resetModules();
  });

  afterEach(async () => {
    jest.resetModules();
    if (envSnap === undefined) delete process.env.BRI_VECTOR_WORKER;
    else process.env.BRI_VECTOR_WORKER = envSnap;

    await import('../../src/workers/index-worker-host.js')
      .then((m) => m.disposeWorker?.())
      .catch(() => {});
    await fs.rm(DATA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(`${DATA}-str`, { recursive: true, force: true }).catch(() => {});
  });

  test('logs warning when host shim fails to evaluate (dynamic import rejects)', async () => {
    process.env.BRI_VECTOR_WORKER = 'yes';

    await jest.unstable_mockModule('../../src/workers/index-worker-host.js', () => {
      throw new Error('simulated worker host module load failure');
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { openLocalDatabase } = await import('../helpers/open-database.js');

    const db = await openLocalDatabase({
      storeConfig: { dataDir: DATA, maxMemoryMB: 48 }
    });

    expect(db.disconnect).toBeDefined();
    await db.disconnect();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/vector worker preload module failed .*simulated worker host module load failure/s)
    );
    warnSpy.mockRestore();
  });

  test('stringifies non-Error rejections in preload warning', async () => {
    process.env.BRI_VECTOR_WORKER = 'on';

    await jest.unstable_mockModule('../../src/workers/index-worker-host.js', () => {
      throw 'simulated string rejection';
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { openLocalDatabase } = await import('../helpers/open-database.js');

    const db = await openLocalDatabase({
      storeConfig: { dataDir: `${DATA}-str`, maxMemoryMB: 48 }
    });
    await db.disconnect();

    expect(warnSpy).toHaveBeenCalledWith(
      'bri-db: vector worker preload module failed (simulated string rejection)'
    );
    warnSpy.mockRestore();
  });
});
