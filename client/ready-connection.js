/**
 * @file Await-able open helpers — **not** the default product surface (`bri.connect`).
 *
 * Servers, examples, and E2E tests need a fully READY façade for synchronous errors
 * and teardown; applications normally use **`import bri from 'bri-db'; bri.connect(opts)`**.
 */

import { createLocalDatabasePromise } from './create-local-db.js';
import { createRemoteDatabasePromise } from '../remote/index.js';

/** Same `/api/ape` normalization as `bri.js`. */
export function normalizedWsUrl(url) {
  return url.endsWith('/api/ape') ? url : `${url}/api/ape`;
}

/**
 * Local in-house database after storage/engine READY.
 *
 * Returns the real {@link Database} (not the pre-READY {@link deferDatabase} shell)
 * so READY-only tests and servers see `db.use` chainability and synchronous surface
 * behaviour matching post-READY `bri.connect`.
 *
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function openLocalDatabase(options = {}) {
  return createLocalDatabasePromise(options);
}

/**
 * Remote façade after WebSocket OPEN.
 *
 * @param {string} url - Base WS URL
 * @param {Object} [options] - forwarded to RPC timeout
 * @returns {Promise<Object>}
 */
export async function openRemoteDatabase(url, options = {}) {
  return createRemoteDatabasePromise(normalizedWsUrl(url), options);
}
