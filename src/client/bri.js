/**
 * @file Sync `bri` SDK object — canonical entry after `import bri from 'bri-db'`.
 *
 * Domain: applications wire `const db = bri.connect(opts)` without awaiting
 * connect; buffering semantics for pre-READY calls are implemented by
 * {@link deferDatabase} chaining on inner Promises (`createLocalDatabasePromise`,
 * `createRemoteDatabasePromise`).
 *
 * Technical: discriminates remote (`url`/`wsUrl`) vs local backing; rejects
 * conflicting option shapes; forwards WebSocket `/api/ape` normalization
 * (same as {@link normalizedWsUrl} / remote handshake).
 */

import { createRequire } from 'module';
import { deferDatabase } from './defer-database.js';
import { createLocalDatabasePromise } from './create-local-db.js';
import { createRemoteDatabasePromise } from '../remote/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * Normalize a WebSocket base URL to Bri's RPC path expectation.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeWsUrl(baseUrl) {
  return baseUrl.endsWith('/api/ape') ? baseUrl : `${baseUrl}/api/ape`;
}

/**
 * `@throws TypeError` when remote URL keys are mixed with local store options.
 *
 * @param {Record<string, unknown>} opts
 */
function assertConnectOptionsValid(opts) {
  const ws = opts.url ?? opts.wsUrl;
  const hasRemote = ws !== undefined && ws !== null && ws !== '';

  const hasLocal = opts.storeConfig !== undefined || opts.storeType !== undefined;

  if (hasRemote && hasLocal) {
    throw new TypeError(
      'bri.connect: cannot combine remote connection (url, wsUrl) with local store options (storeConfig, storeType)'
    );
  }
}

/**
 * Public Bri SDK — default export of the main package.
 *
 * @namespace
 */
export const bri = {
  /**
   * Package version from `package.json` (the published artifact version).
   *
   * @readonly
   * @type {string}
   */
  version: String(pkg.version),

  /**
   * Open a database handle synchronously. Backing storage or first-hop WebSocket
   * readiness is asynchronous; calls issued before READY are deferred in order.
   *
 * @param {Record<string, unknown>} [opts]
 * @returns {Object}
   */
  connect(opts = {}) {
    assertConnectOptionsValid(/** @type {Record<string, unknown>} */ (opts));

    const rawUrl = opts.url ?? opts.wsUrl;
    if (rawUrl != null && rawUrl !== '') {
      const wsUrl = normalizeWsUrl(String(rawUrl));
      return deferDatabase(createRemoteDatabasePromise(wsUrl, opts));
    }

    return deferDatabase(createLocalDatabasePromise(opts));
  }
};

export default bri;
