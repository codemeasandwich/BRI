/**
 * @file Local database bootstrap — async construction of the in-process Database
 * after storage + engine wiring.
 *
 * Domain: `bri.connect` returns a synchronous façade; callers issue `db.*`
 * immediately while `InHouseAdapter.connect` (and store init) may still run.
 * This module is the sole async path that produces the real {@link Database}.
 *
 * Technical: local backing builder for `bri.connect`; kept separate from
 * `client/index.js` so `bri.js` can import it without circular dependencies
 * with the synchronous `bri` barrel.
 */

import { createStore } from '../storage/index.js';
import { createEngine } from '../engine/index.js';
import { createDBInterface } from './proxy.js';
import { isVectorWorkerWarmRequestedFromEnv } from '../workers/vector-worker-env.js';

/**
 * Resolve to a connected local {@link Database} (in-house storage by default).
 *
 * @param {Object} [options]
 * @param {'inhouse'} [options.storeType]
 * @param {Object} [options.storeConfig] - Passed to {@link createStore}
 * @returns {Promise<Object>} Real database façade (same shape as `deferDatabase`/local connect)
 */
export async function createLocalDatabasePromise(options = {}) {
  const store = await createStore({
    type: options.storeType || 'inhouse',
    config: options.storeConfig || {
      dataDir: process.env.BRI_DATA_DIR || './data',
      maxMemoryMB: parseInt(process.env.BRI_MAX_MEMORY_MB) || 256
    }
  });

  console.log('BRI: Connected to storage');

  if (isVectorWorkerWarmRequestedFromEnv()) {
    try {
      const { warmVectorWorkerFromEnv } = await import('../workers/index-worker-host.js');
      warmVectorWorkerFromEnv();
    } catch (err) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? /** @type {Error} */ (err).message
          : String(err);
      console.warn(`bri-db: vector worker preload module failed (${msg})`);
    }
  }

  const engine = createEngine(store);
  return createDBInterface(engine, store);
}
