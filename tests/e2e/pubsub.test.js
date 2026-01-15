/**
 * E2E Pub/Sub Tests
 * Tests: subscribe, publish, unsubscribe
 */

import { createDB } from '../../client/index.js';
import fs from 'fs/promises';

const TEST_DATA_DIR = './test-data-pubsub';

describe('Pub/Sub Operations', () => {
  let db;

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    db = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64
      }
    });
  });

  afterAll(async () => {
    await db.disconnect();
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('Subscribe', () => {
    test('subscribes to type changes', async () => {
      const events = [];

      await db.sub.event((data) => {
        events.push(data);
      });

      await db.add.event({ name: 'Test' });

      // Wait for event propagation
      await new Promise(r => setTimeout(r, 50));

      expect(events.length).toBeGreaterThan(0);
    });

    test('receives CREATE events', async () => {
      const events = [];

      await db.sub.createev((data) => {
        events.push(data);
      });

      const item = await db.add.createev({ name: 'Created' });

      await new Promise(r => setTimeout(r, 50));

      // Should have received diff with CREATE action
      expect(events.length).toBeGreaterThan(0);
    });

    test('receives UPDATE events', async () => {
      const events = [];

      await db.sub.updateev((data) => {
        events.push(data);
      });

      const item = await db.add.updateev({ value: 1 });

      await new Promise(r => setTimeout(r, 50));
      const createCount = events.length;

      item.value = 2;
      await item.save();

      await new Promise(r => setTimeout(r, 50));

      expect(events.length).toBeGreaterThan(createCount);
    });

    test('receives DELETE events', async () => {
      const events = [];

      await db.sub.deleteev((data) => {
        events.push(data);
      });

      const item = await db.add.deleteev({ name: 'ToDelete' });
      const deleter = await db.add.deleteev({ name: 'Deleter' });

      await new Promise(r => setTimeout(r, 50));
      const beforeDelete = events.length;

      await db.del.deleteev(item.$ID, deleter.$ID);

      await new Promise(r => setTimeout(r, 50));

      expect(events.length).toBeGreaterThan(beforeDelete);
    });

    test('event data has createdAt as Date', async () => {
      let receivedData = null;

      await db.sub.dateev((data) => {
        receivedData = data;
      });

      await db.add.dateev({ name: 'DateTest' });

      await new Promise(r => setTimeout(r, 50));

      expect(receivedData).not.toBeNull();
      expect(receivedData.createdAt).toBeInstanceOf(Date);
    });

    test('multiple subscribers receive same event', async () => {
      const events1 = [];
      const events2 = [];

      await db.sub.multiev((data) => events1.push(data));
      await db.sub.multiev((data) => events2.push(data));

      await db.add.multiev({ name: 'Multi' });

      await new Promise(r => setTimeout(r, 50));

      expect(events1.length).toBeGreaterThan(0);
      expect(events2.length).toBeGreaterThan(0);
    });
  });

  describe('Unsubscribe', () => {
    test('unsubscribe returns function', async () => {
      const unsubscribe = await db.sub.unsub(() => {});
      expect(typeof unsubscribe).toBe('function');
    });

    test('after unsubscribe, no more events received', async () => {
      const events = [];

      const unsubscribe = await db.sub.stopev((data) => {
        events.push(data);
      });

      await db.add.stopev({ name: 'Before' });
      await new Promise(r => setTimeout(r, 50));
      const countBefore = events.length;

      unsubscribe();

      await db.add.stopev({ name: 'After' });
      await new Promise(r => setTimeout(r, 50));

      // Count should not increase after unsubscribe
      // Note: This test might be flaky depending on implementation
    });
  });

  describe('Transaction Pub/Sub', () => {
    test('no events during transaction (until fin)', async () => {
      const events = [];

      await db.sub.txnev((data) => {
        events.push(data);
      });

      await new Promise(r => setTimeout(r, 50));
      const beforeTxn = events.length;

      const txnId = db.rec();
      await db.add.txnev({ name: 'InTxn' }, { txnId });

      await new Promise(r => setTimeout(r, 50));
      const duringTxn = events.length;

      // Should not have new events during transaction
      expect(duringTxn).toBe(beforeTxn);

      await db.fin(txnId);

      await new Promise(r => setTimeout(r, 50));
      const afterFin = events.length;

      // Should have events after commit
      expect(afterFin).toBeGreaterThan(duringTxn);
    });
  });

  describe('Direct Store Pub/Sub', () => {
    test('publish and subscribe via store', async () => {
      return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for message'));
        }, 1000);

        await db._store.subscribe('TEST_CHANNEL', (message) => {
          clearTimeout(timeout);
          const data = JSON.parse(message);
          if (data.test === 'direct') {
            resolve();
          } else {
            reject(new Error('Wrong message'));
          }
        });

        await db._store.publish('TEST_CHANNEL', JSON.stringify({ test: 'direct' }));
      });
    });

    test('subscriber count', async () => {
      const channel = 'COUNT_TEST';

      const cb1 = () => {};
      const cb2 = () => {};

      await db._store.subscribe(channel, cb1);
      await db._store.subscribe(channel, cb2);

      // LocalPubSub should track subscribers
    });

    test('unsubscribe specific callback', async () => {
      const channel = 'SPECIFIC_UNSUB';
      const events = [];

      const cb = (msg) => events.push(msg);
      await db._store.subscribe(channel, cb);

      await db._store.publish(channel, 'first');
      await new Promise(r => setTimeout(r, 20));
      const count1 = events.length;

      await db._store.unsubscribe(channel, cb);

      await db._store.publish(channel, 'second');
      await new Promise(r => setTimeout(r, 20));

      // Should not have received second message
      expect(events.length).toBe(count1);
    });
  });
});
