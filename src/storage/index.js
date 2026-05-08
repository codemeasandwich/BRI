/**
 * @file BRI storage adapter factory and public storage exports.
 *
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
  const baseConfig = options.config || {
    dataDir: './data',
    maxMemoryMB: 256
  };
  const config = options.logger !== undefined && baseConfig.logger === undefined
    ? { ...baseConfig, logger: options.logger }
    : baseConfig;
  const adapter = new InHouseAdapter(config);

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
