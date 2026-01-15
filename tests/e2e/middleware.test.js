/**
 * E2E Middleware Tests
 * Tests: use, remove, clear, custom middleware, built-in middleware
 */

import { createDB } from '../../client/index.js';
import {
  createMiddleware,
  transactionMiddleware,
  loggingMiddleware,
  validationMiddleware,
  hooksMiddleware
} from '../../engine/middleware.js';
import fs from 'fs/promises';

const TEST_DATA_DIR = './test-data-middleware';

describe('Middleware System', () => {
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

  describe('createMiddleware', () => {
    test('creates middleware manager', () => {
      const mw = createMiddleware();
      expect(mw.use).toBeDefined();
      expect(mw.remove).toBeDefined();
      expect(mw.clear).toBeDefined();
      expect(mw.count).toBe(0);
    });

    test('use() adds middleware', () => {
      const mw = createMiddleware();
      mw.use(async (ctx, next) => next());
      expect(mw.count).toBe(1);
    });

    test('use() throws on non-function', () => {
      const mw = createMiddleware();
      expect(() => mw.use('not a function')).toThrow();
    });

    test('remove() removes middleware', () => {
      const mw = createMiddleware();
      const fn = async (ctx, next) => next();
      mw.use(fn);
      expect(mw.count).toBe(1);
      mw.remove(fn);
      expect(mw.count).toBe(0);
    });

    test('remove() ignores non-existent', () => {
      const mw = createMiddleware();
      mw.remove(() => {});
      expect(mw.count).toBe(0);
    });

    test('clear() removes all', () => {
      const mw = createMiddleware();
      mw.use(async (ctx, next) => next());
      mw.use(async (ctx, next) => next());
      mw.clear();
      expect(mw.count).toBe(0);
    });

    test('run() executes middleware chain', async () => {
      const mw = createMiddleware();
      const order = [];

      mw.use(async (ctx, next) => {
        order.push(1);
        await next();
        order.push(4);
      });
      mw.use(async (ctx, next) => {
        order.push(2);
        await next();
        order.push(3);
      });

      await mw.run({}, async () => {
        order.push('final');
      });

      expect(order).toEqual([1, 2, 'final', 3, 4]);
    });

    test('middleware can modify context', async () => {
      const mw = createMiddleware();

      mw.use(async (ctx, next) => {
        ctx.modified = true;
        await next();
      });

      const ctx = {};
      await mw.run(ctx, async () => {});

      expect(ctx.modified).toBe(true);
    });

    test('middleware can short-circuit', async () => {
      const mw = createMiddleware();
      let finalCalled = false;

      mw.use(async (ctx, next) => {
        // Don't call next()
      });

      await mw.run({}, async () => {
        finalCalled = true;
      });

      expect(finalCalled).toBe(false);
    });
  });

  describe('DB Middleware Integration', () => {
    test('db.use() adds middleware', async () => {
      const intercepted = [];

      db.use(async (ctx, next) => {
        intercepted.push(ctx.operation);
        await next();
      });

      await db.add.mwint({ name: 'Test' });

      expect(intercepted).toContain('add');
    });

    test('db.use() is chainable', () => {
      const result = db.use(async (ctx, next) => next());
      expect(result).toBe(db);
    });

    test('middleware receives correct context', async () => {
      let receivedCtx = null;

      const mw = async (ctx, next) => {
        receivedCtx = ctx;
        await next();
      };

      db.use(mw);
      await db.add.ctxtest({ data: 'value' });
      db.middleware.remove(mw);

      expect(receivedCtx.operation).toBe('add');
      expect(receivedCtx.type).toBe('ctxtest');
      expect(receivedCtx.db).toBe(db);
    });

    test('middleware.remove() works', async () => {
      const calls = [];
      const mw = async (ctx, next) => {
        calls.push(1);
        await next();
      };

      db.use(mw);
      await db.add.remtest({ name: 'First' });
      expect(calls.length).toBe(1);

      db.middleware.remove(mw);
      await db.add.remtest({ name: 'Second' });
      expect(calls.length).toBe(1); // Should not increase
    });
  });

  describe('transactionMiddleware', () => {
    test('injects active txnId', async () => {
      const txnId = db.rec();

      // Middleware should auto-inject txnId
      const item = await db.add.txninject({ name: 'Auto' });

      // Should be in transaction
      const inTxn = await db.get.txninjectS({ txnId });
      expect(inTxn.length).toBe(1);

      await db.nop(txnId);
    });

    test('respects explicit txnId', async () => {
      const txn1 = db.rec();
      const txn2 = db._store.rec(); // Second transaction

      // Use explicit txnId different from active
      await db.add.explicit({ name: 'Explicit' }, { txnId: txn2 });

      // Should be in txn2, not txn1
      const inTxn2 = await db.get.explicitS({ txnId: txn2 });
      expect(inTxn2.length).toBe(1);

      const inTxn1 = await db.get.explicitS({ txnId: txn1 });
      expect(inTxn1.length).toBe(0);

      await db.nop(txn1);
      await db._store.nop(txn2);
    });

    test('txnId: null removes from opts', async () => {
      db.rec();

      // Bypass transaction
      await db.add.nulltxn({ name: 'NoTxn' }, { txnId: null });

      // Should be visible without transaction
      const items = await db.get.nulltxnS({ txnId: null });
      expect(items.length).toBe(1);

      await db.nop();
    });
  });

  describe('loggingMiddleware', () => {
    test('logs operations', async () => {
      const mw = createMiddleware();
      const logs = [];

      // Mock console.log
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      mw.use(loggingMiddleware({ prefix: '[TEST]' }));

      await mw.run({ operation: 'add', type: 'logtest' }, async () => {});

      console.log = originalLog;

      expect(logs.some(l => l.includes('[TEST]'))).toBe(true);
    });

    test('logs with results when enabled', async () => {
      const mw = createMiddleware();
      const logs = [];

      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      mw.use(loggingMiddleware({ prefix: '[RESULT]', logResults: true }));

      await mw.run({ operation: 'get', type: 'resulttest', result: { data: 'test' } }, async (ctx) => {
        ctx.result = { data: 'test' };
      });

      console.log = originalLog;

      expect(logs.some(l => l.includes('[RESULT]'))).toBe(true);
    });
  });

  describe('validationMiddleware', () => {
    test('validates on add', async () => {
      const mw = createMiddleware();

      mw.use(validationMiddleware({
        valtest: (data) => {
          const errors = [];
          if (!data.name) errors.push('name required');
          return errors;
        }
      }));

      await expect(
        mw.run({ operation: 'add', type: 'valtest', args: [{}] }, async () => {})
      ).rejects.toThrow('name required');
    });

    test('validates on set', async () => {
      const mw = createMiddleware();

      mw.use(validationMiddleware({
        valset: (data) => {
          const errors = [];
          if (!data.$ID) errors.push('$ID required');
          return errors;
        }
      }));

      await expect(
        mw.run({ operation: 'set', type: 'valset', args: [{}] }, async () => {})
      ).rejects.toThrow('$ID required');
    });

    test('passes valid data', async () => {
      const mw = createMiddleware();

      mw.use(validationMiddleware({
        valid: (data) => []
      }));

      await mw.run({ operation: 'add', type: 'valid', args: [{ name: 'Valid' }] }, async () => {});
      // Should not throw
    });

    test('uses wildcard validator', async () => {
      const mw = createMiddleware();

      mw.use(validationMiddleware({
        '*': (data) => data.blocked ? ['blocked'] : []
      }));

      await expect(
        mw.run({ operation: 'add', type: 'anytype', args: [{ blocked: true }] }, async () => {})
      ).rejects.toThrow('blocked');
    });

    test('skips non-add/set operations', async () => {
      const mw = createMiddleware();

      mw.use(validationMiddleware({
        skiptype: () => ['should not run']
      }));

      await mw.run({ operation: 'get', type: 'skiptype', args: [] }, async () => {});
      // Should not throw
    });
  });

  describe('hooksMiddleware', () => {
    test('runs before hooks', async () => {
      const mw = createMiddleware();
      const hooks = hooksMiddleware();
      mw.use(hooks);

      const order = [];
      hooks.before('add', 'hooktest', async (ctx) => {
        order.push('before');
      });

      await mw.run({ operation: 'add', type: 'hooktest' }, async () => {
        order.push('main');
      });

      expect(order).toEqual(['before', 'main']);
    });

    test('runs after hooks', async () => {
      const mw = createMiddleware();
      const hooks = hooksMiddleware();
      mw.use(hooks);

      const order = [];
      hooks.after('add', 'hookafter', async (ctx) => {
        order.push('after');
      });

      await mw.run({ operation: 'add', type: 'hookafter' }, async () => {
        order.push('main');
      });

      expect(order).toEqual(['main', 'after']);
    });

    test('wildcard hooks match all types', async () => {
      const mw = createMiddleware();
      const hooks = hooksMiddleware();
      mw.use(hooks);

      const types = [];
      hooks.before('add', '*', async (ctx) => {
        types.push(ctx.type);
      });

      await mw.run({ operation: 'add', type: 'wildcard1' }, async () => {});
      await mw.run({ operation: 'add', type: 'wildcard2' }, async () => {});

      expect(types).toContain('wildcard1');
      expect(types).toContain('wildcard2');
    });
  });
});
