/**
 * BRI Storage - Storage adapter factory
 *
 * Provides a unified interface for storage backends.
 * Supports: InHouse
 */

import { InHouseAdapter } from './adapters/inhouse.js';
import { HotTierCache } from './hot-tier/cache.js';
import { WALWriter } from './wal/writer.js';
import { WALReader } from './wal/reader.js';
import { ColdTierFiles } from './cold-tier/files.js';
import { SnapshotManager } from './snapshot/manager.js';
import { LocalPubSub } from './pubsub/local.js';
import { validateConfig, DEFAULTS } from './interface.js';

/**
 * Create a storage adapter
 * @param {Object} options
 * @param {Object} options.config - Store config
 * @returns {Promise<Object>}
 */
export async function createStore(options = {}) {
  const adapter = new InHouseAdapter(options.config || {
    dataDir: './data',
    maxMemoryMB: 256
  });

  await adapter.connect();
  return adapter;
}

export {
  InHouseAdapter,
  HotTierCache,
  WALWriter,
  WALReader,
  ColdTierFiles,
  SnapshotManager,
  LocalPubSub,
  validateConfig,
  DEFAULTS
};
