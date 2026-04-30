/**
 * @file E2E coverage for `bri.connect` — sync façade, pre-READY buffering, READY drain.
 *
 * Bri only guarantees application-level queueing until local storage or remote
 * first-hop OPEN completes; post-READY transport behavior is out of scope.
 */

import fs from 'fs/promises';
import bri from '../../index.js';
import { startMockWsRpcServer } from '../helpers/mock-bri-ws-rpc-server.js';

const LOCAL_DIR = './test-data-bri-connect';

describe('bri.connect', () => {
  afterEach(async () => {
    await fs.rm(LOCAL_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('local: schema + add without awaiting connect', async () => {
    await fs.rm(LOCAL_DIR, { recursive: true, force: true }).catch(() => {});

    const db = bri.connect({
      storeConfig: { dataDir: LOCAL_DIR, maxMemoryMB: 32 }
    });

    db.schema('user', {
      name: { type: String, required: true }
    });

    const doc = await db.add.user({ name: 'SyncConnect' });
    expect(doc.name).toBe('SyncConnect');
    expect(doc.$ID).toMatch(/^USER_/);

    await db.disconnect();
  });

  test('local: sequential pre-READY operations preserve transaction intent (rec then add)', async () => {
    await fs.rm(LOCAL_DIR, { recursive: true, force: true }).catch(() => {});

    const db = bri.connect({
      storeConfig: { dataDir: LOCAL_DIR, maxMemoryMB: 64 }
    });

    db.schema('user', {
      name: { type: String, required: true }
    });

    const txnPromise = db.rec();
    const addPromise = db.add.user({ name: 'Queued' });

    await txnPromise;
    await addPromise;
    await db.fin();

    const users = await db.get.userS();
    expect(users.some((u) => u.name === 'Queued')).toBe(true);

    await db.disconnect();
  });

  test('remote: queues _rpc until OPEN then preserves send order', async () => {
    const server = await startMockWsRpcServer();
    try {
      const db = bri.connect({
        url: `ws://127.0.0.1:${server.port}`
      });

      /** @type {Promise<any>[]} */
      const payloads = [];
      payloads.push(db._rpc('rpc/a', { seq: 1 }));
      payloads.push(db._rpc('rpc/b', { seq: 2 }));

      const results = await Promise.all(payloads);
      expect(results[0].payload.seq).toBe(1);
      expect(results[1].payload.seq).toBe(2);

      await db.disconnect();
    } finally {
      await server.close();
    }
  });

  test('connect rejects conflicting remote URL and local store options', () => {
    expect(() =>
      bri.connect({
        url: 'ws://localhost:3000',
        storeConfig: { dataDir: './x', maxMemoryMB: 32 }
      })
    ).toThrow(/cannot combine remote/);
  });
});
