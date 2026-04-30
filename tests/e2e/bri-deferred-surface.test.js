/**
 * @file Istanbul coverage for deferred façade + READY helpers: {@link deferDatabase},
 * {@link normalizedWsUrl}, {@link openRemoteDatabase}, and `client/index.js` barrel parity.
 */

import fs from 'fs/promises';
import { describe, test, expect, beforeEach } from '@jest/globals';
import briRoot, {
  createLocalDatabasePromise,
  deferDatabase,
  normalizedWsUrl,
  openRemoteDatabase
} from '../../index.js';
import * as clientBarrel from '../../src/client/index.js';
import { startMockWsRpcServer } from '../helpers/mock-bri-ws-rpc-server.js';

describe('bri deferred façade + READY export coverage', () => {
  beforeEach(() =>
    fs.rm('./test-data-bri-defer-cover', { recursive: true, force: true }).catch(() => {})
  );

  test('client barrel re-exports the same bri default as the package root', async () => {
    const mod = await import('../../src/client/index.js');
    expect(mod.default).toBe(clientBarrel.default);
    expect(mod.default).toBe(briRoot);
    expect(clientBarrel.bri).toBe(briRoot);
    expect(typeof clientBarrel.deferDatabase).toBe('function');
    expect(mod.deferDatabase).toBe(clientBarrel.deferDatabase);
  });

  test('createLocalDatabasePromise(undefined) binds the default-parameter branch', async () => {
    const prev = process.env.BRI_DATA_DIR;
    const dir = './test-data-bri-local-promise-undef';
    process.env.BRI_DATA_DIR = dir;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    try {
      const db = await createLocalDatabasePromise(undefined);
      expect(db.disconnect).toBeDefined();
      await db.disconnect();
    } finally {
      if (prev === undefined) delete process.env.BRI_DATA_DIR;
      else process.env.BRI_DATA_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('bri.connect(undefined) exercises default connect options', async () => {
    const prev = process.env.BRI_DATA_DIR;
    const dir = './test-data-bri-connect-undef';
    process.env.BRI_DATA_DIR = dir;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    try {
      const db = briRoot.connect(undefined);
      expect(db.disconnect).toBeDefined();
      await db.disconnect();
    } finally {
      if (prev === undefined) delete process.env.BRI_DATA_DIR;
      else process.env.BRI_DATA_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('normalizedWsUrl preserves or appends /api/ape exactly once', () => {
    expect(normalizedWsUrl('ws://127.0.0.1:9/api/ape')).toBe(
      'ws://127.0.0.1:9/api/ape'
    );
    expect(normalizedWsUrl('ws://127.0.0.1:9')).toBe(
      'ws://127.0.0.1:9/api/ape'
    );
  });

  test('openRemoteDatabase reaches WebSocket OPEN and disconnects cleanly', async () => {
    const server = await startMockWsRpcServer();
    try {
      const base = `ws://127.0.0.1:${server.port}`;
      const db = await openRemoteDatabase(base);
      expect(db._rpc).toBeDefined();
      await db.disconnect();
    } finally {
      await server.close();
    }
  });

  test('bri.connect accepts wsUrl and keeps /api/ape when base URL already normalized', async () => {
    const server = await startMockWsRpcServer();
    try {
      const base = `ws://127.0.0.1:${server.port}`;
      let db = briRoot.connect({
        wsUrl: `${base}/api/ape`
      });
      expect(db._rpc).toBeDefined();
      await db.disconnect();

      db = briRoot.connect({ url: `${base}/api/ape` });
      const res = await db._rpc('ping', {});
      expect(res).toHaveProperty('type', 'ping');
      await db.disconnect();
    } finally {
      await server.close();
    }
  });

  test('connect rejects conflicting wsUrl plus local storeType', () => {
    expect(() =>
      briRoot.connect({
        wsUrl: 'ws://localhost:1',
        storeType: 'inhouse'
      })
    ).toThrow(/cannot combine remote/);
  });

  test('deferDatabase rejects invoking when the resolved leaf is not callable', async () => {
    const d = deferDatabase(Promise.resolve({ x: /** @type {unknown} */ (42) }));

    /** @suppress {missingProperties} */
    await expect(d.x()).rejects.toThrow(
      /Deferred database: cannot invoke non-function/
    );
  });

  test('deferDatabase root apply resolves then Reflect-applies callable backing', async () => {
    const d = deferDatabase(
      Promise.resolve(
        /** @returns {Promise<string>} */
        async function callee() {
          return 'ok-call';
        }
      )
    );
    await Promise.resolve();
    /** @suppress {missingProperties} */
    const out = /** @type {Promise<string>} */ (d());
    expect(await out).toBe('ok-call');
  });

  test('deferDatabase root apply throws TypeError when resolved backing is not callable', async () => {
    const d = deferDatabase(Promise.resolve({}));
    await Promise.resolve();

    /** @suppress {missingProperties} */
    await expect(Promise.resolve().then(() => d())).rejects.toThrow(TypeError);
  });

  test('deferDatabase surfaces PASS_THROUGH symbols, `then`, and custom Symbols on nested/root shells before READY', () => {
    const never = /** @type {Promise<never>} */ (new Promise(() => {}));

    /** @suppress {missingProperties} */
    const facade = deferDatabase(never);
    /** @suppress {missingProperties} */
    const deferGet = facade.get;

    expect(Reflect.get(/** @type {object} */ (deferGet), Symbol.toPrimitive)).toBe(
      undefined
    );
    /** @suppress {missingProperties} */
    expect(deferGet.then).toBe(undefined);
    expect(Reflect.get(/** @type {object} */ (deferGet), Symbol('nest'))).toBe(
      undefined
    );

    expect(Reflect.get(/** @type {object} */ (facade), Symbol.toPrimitive)).toBe(
      undefined
    );
    /** @suppress {missingProperties} */
    expect(facade.then).toBe(undefined);

    const symRoot = Symbol('rootSym');
    expect(Reflect.get(/** @type {object} */ (facade), symRoot)).toBe(undefined);
  });

  test('deferDatabase multi-segment invoke fails when backing supplies undefined or null mid-path', async () => {
    /** @type {(v: Record<string, unknown>) => void | undefined} */
    let resolveUndef;
    const pUndef = new Promise((resolve) => {
      resolveUndef = resolve;
    });

    /** @suppress {missingProperties} */
    const dUndef = deferDatabase(pUndef);
    /** @suppress {missingProperties} */
    const stagedUndef = dUndef.a.b();

    resolveUndef?.({ a: /** @type {unknown} */ (undefined) });

    await expect(stagedUndef).rejects.toThrow();

    /** @type {(v: Record<string, unknown>) => void | undefined} */
    let resolveNull;
    const pNull = new Promise((resolve) => {
      resolveNull = resolve;
    });

    /** @suppress {missingProperties} */
    const dNull = deferDatabase(pNull);
    /** @suppress {missingProperties} */
    const stagedNull = dNull.a.b();

    resolveNull?.({ a: /** @type {unknown} */ (null) });

    await expect(stagedNull).rejects.toThrow();
  });

  test('deferDatabase deferred invoke rejects when backing rejects', async () => {
    /** @suppress {missingProperties} */
    const broken = deferDatabase(Promise.reject(new Error('backing fail')));
    await expect(broken.x()).rejects.toThrow('backing fail');
  });

  test('defer node apply passes an array arguments list to Invoke (arity 0 on callee)', async () => {
    let resolveOuter;
    const p = new Promise((resolve) => {
      resolveOuter = resolve;
    });
    /** @suppress {missingProperties} */
    const facade = deferDatabase(p);
    /** @suppress {missingProperties} */
    const child = facade.x;

    resolveOuter({
      /** @suppress {missingProperties} Records whether apply saw coalesced args. */
      x: /** @returns {unknown} */ function xFn(/* no args*/) {
        return arguments.length === 0 ? 'empty-args-list' : 'bad';
      }
    });

    /** @suppress {missingProperties} With `()`, Proxy `apply` passes a real array (`[]`); callee sees `arguments.length === 0`. */
    const queued = /** @type {Promise<string>} */ (child());
    await expect(queued).resolves.toBe('empty-args-list');
  });

  test('deferDatabase deep dotted invoke rejects when fulfillment omits callable leaf', async () => {
    /** @type {(v: Record<string, unknown>) => void | undefined} */
    let resolveBacking;

    const backingPromise = new Promise((resolve) => {
      resolveBacking = resolve;
    });

    /** @suppress {missingProperties} */
    const facade = deferDatabase(backingPromise);
    /** @suppress {missingProperties} */
    const staged = facade.a.b();

    resolveBacking?.({ a: {} });

    await expect(staged).rejects.toThrow(
      /Deferred database: cannot invoke non-function/
    );
  });
});
