/**
 * @file E2E tests for Bri's configurable local runtime logger boundary.
 *
 * These scenarios exercise storage boot, WAL/snapshot lifecycle, and failure
 * handling through public database entrypoints. The contract is that embedded
 * applications can capture structured events without scraping terminal output.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import http from 'http';
import { WebSocketServer } from 'ws';
import { openLocalDatabase, openRemoteDatabase } from '../helpers/open-database.js';

const DATA_DIR = './test-data-observability-logger';

/**
 * Build a structured logger that records every Bri event by severity while
 * keeping the test assertions independent of terminal output formatting.
 *
 * @returns {{logger:Object, events:Array<Object>}}
 */
function captureLogger() {
  const events = [];
  const sink = (event) => events.push(event);
  return {
    events,
    logger: {
      info: sink,
      warn: sink,
      error: sink,
      debug: sink
    }
  };
}

/**
 * Start a local key-service fixture for encrypted database boot scenarios.
 * The remote key provider calls `/keys/current`; this helper returns one valid
 * AES-256-GCM key first and can then switch to failures for refresh testing.
 *
 * @param {Object} options - Mock behavior flags.
 * @param {boolean} [options.failAfterFirst=false] - Fail refreshes after boot.
 * @returns {Promise<{endpoint:string, close:Function, requests:Array<string>}>}
 */
async function startKeyService({ failAfterFirst = false } = {}) {
  const requests = [];
  const key = Buffer.alloc(32, 7).toString('base64');
  let served = 0;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (failAfterFirst && served > 0) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'refresh unavailable' }));
      return;
    }
    served++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keyId: 'fixture-key', key }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Start a WebSocket RPC fixture that can emit malformed frames and
 * subscription broadcasts so remote-client observability is tested through the
 * same public `openRemoteDatabase` surface that embeddings use.
 *
 * @returns {Promise<{endpoint:string, close:Function}>}
 */
async function startRemoteDiagnosticsServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve, reject) => {
    wss.on('listening', resolve);
    wss.on('error', reject);
  });
  wss.on('connection', (ws) => {
    ws.send('not-json');
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      ws.send(JSON.stringify({
        queryId: msg.queryId,
        result: { type: msg.type, payload: msg.payload },
        error: null
      }));
      if (msg.type === 'db/sub/user') {
        ws.send(JSON.stringify({
          type: 'db:sub:user',
          data: { $ID: 'USER_remote', name: 'Remote' }
        }));
      }
    });
  });
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    endpoint: `ws://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) =>
      wss.close((err) => (err ? reject(err) : resolve()))
    )
  };
}

/**
 * Poll captured logger events until a specific event arrives or the scenario
 * times out with a useful assertion error.
 *
 * @param {Array<Object>} events - Captured structured logger events.
 * @param {string} eventName - Expected event code.
 * @returns {Promise<Object>} Matching event.
 */
async function waitForEvent(events, eventName) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const found = events.find((event) => event.event === eventName);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}

describe('Configurable database observability logger', () => {
  beforeEach(async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('default local database boot still emits useful lifecycle observability', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const db = await openLocalDatabase({
      storeConfig: {
        dataDir: DATA_DIR,
        maxMemoryMB: 64
      }
    });

    try {
      expect(logSpy.mock.calls.some((call) =>
        String(call[0]).includes('BRI: Connected to storage')
      )).toBe(true);
      expect(logSpy.mock.calls.some((call) =>
        String(call[0]).includes('InHouse Store: Connected and ready')
      )).toBe(true);
    } finally {
      await db.disconnect();
      logSpy.mockRestore();
    }
  });

  test('custom logger receives structured lifecycle events without raw console output', async () => {
    const { logger, events } = captureLogger();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const db = await openLocalDatabase({
      logger,
      storeConfig: {
        dataDir: DATA_DIR,
        maxMemoryMB: 64,
        snapshotIntervalMs: 999999
      }
    });

    try {
      db.schema('alpha', { name: { type: String, required: true } });
      await db.add.alpha({ name: 'logged' });
      await db._store.createSnapshot();
    } finally {
      await db.disconnect();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'storage.snapshot.missing',
        level: 'info',
        severity: 'info'
      }),
      expect.objectContaining({
        event: 'storage.inhouse.connected',
        message: 'InHouse Store: Connected and ready'
      }),
      expect.objectContaining({
        event: 'client.local.connected',
        message: 'BRI: Connected to storage'
      }),
      expect.objectContaining({
        event: 'storage.snapshot.created',
        metadata: expect.objectContaining({ walLine: expect.any(Number) })
      })
    ]));
  });

  test('logger false silences human stdout for embedded tests', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const db = await openLocalDatabase({
      logger: false,
      storeConfig: {
        dataDir: DATA_DIR,
        maxMemoryMB: 64,
        snapshotIntervalMs: 999999
      }
    });
    await db.add.alpha({ name: 'silent' });
    await db._store.createSnapshot();
    await db.disconnect();

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('failure events preserve the original error object for custom loggers', async () => {
    const { logger, events } = captureLogger();
    const db = await openLocalDatabase({
      logger,
      storeConfig: {
        dataDir: DATA_DIR,
        maxMemoryMB: 64,
        snapshotIntervalMs: 999999
      }
    });

    const failure = new Error('forced snapshot failure');
    failure.cause = new Error('root cause');
    db._store.snapshots.create = async () => {
      throw failure;
    };

    await db.disconnect();

    expect(events).toContainEqual(expect.objectContaining({
      event: 'storage.inhouse.snapshot.final_failed',
      level: 'error',
      severity: 'error',
      error: failure
    }));
    expect(events.find((event) =>
      event.event === 'storage.inhouse.snapshot.final_failed'
    ).error.cause.message).toBe('root cause');
  });

  test('throwing custom logger cannot break storage boot or shutdown', async () => {
    const throwingLogger = {
      info() { throw new Error('logger info failed'); },
      warn() { throw new Error('logger warn failed'); },
      error() { throw new Error('logger error failed'); },
      debug() { throw new Error('logger debug failed'); }
    };

    const db = await openLocalDatabase({
      logger: throwingLogger,
      storeConfig: {
        dataDir: DATA_DIR,
        maxMemoryMB: 64,
        snapshotIntervalMs: 999999
      }
    });

    db.schema('alpha', { name: { type: String, required: true } });
    await db.add.alpha({ name: 'still-boots' });
    await expect(db.disconnect()).resolves.toBeUndefined();
  });

  test('remote client lifecycle and listener failures route through logger boundary', async () => {
    const server = await startRemoteDiagnosticsServer();
    const { logger, events } = captureLogger();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const listenerFailure = new Error('subscriber failed');

    try {
      const db = await openRemoteDatabase(server.endpoint, { logger, timeout: 250 });
      const ping = await db._rpc('ping', { seq: 1 });
      expect(ping.payload.seq).toBe(1);
      await db.sub.user(() => {
        throw listenerFailure;
      });
      const parseEvent = await waitForEvent(events, 'client.remote.message.parse_error');
      const listenerEvent = await waitForEvent(events, 'client.remote.listener_error');
      expect(events).toContainEqual(expect.objectContaining({
        event: 'client.remote.connected',
        level: 'info'
      }));
      expect(parseEvent.error).toBeInstanceOf(Error);
      expect(listenerEvent.error).toBe(listenerFailure);
      await db.disconnect();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('encrypted remote key failures route through the custom logger', async () => {
    const { logger, events } = captureLogger();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(openLocalDatabase({
        logger,
        storeConfig: {
          dataDir: DATA_DIR,
          maxMemoryMB: 64,
          encryption: {
            enabled: true,
            keyProvider: 'remote',
            keyProviderConfig: {
              endpoint: 'http://127.0.0.1:9',
              retryAttempts: 1,
              retryDelayMs: 1,
              timeout: 20
            }
          }
        }
      })).rejects.toThrow();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({
        event: 'crypto.key_provider.fetch_failed',
        level: 'warn',
        error: expect.objectContaining({ message: 'fetch failed' })
      }));
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('encrypted key-refresh failures route through the custom logger', async () => {
    const service = await startKeyService({ failAfterFirst: true });
    const { logger, events } = captureLogger();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = await openLocalDatabase({
      logger,
      storeConfig: {
        dataDir: DATA_DIR,
        maxMemoryMB: 64,
        encryption: {
          enabled: true,
          keyProvider: 'remote',
          keyRefreshIntervalMs: 10,
          keyProviderConfig: {
            endpoint: service.endpoint,
            retryAttempts: 1,
            retryDelayMs: 1,
            timeout: 50
          }
        }
      }
    });

    try {
      const event = await waitForEvent(events, 'crypto.key_manager.refresh_failed');
      expect(event).toMatchObject({
        level: 'error',
        severity: 'error',
        error: expect.any(Error)
      });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      await db.disconnect();
      await service.close();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
