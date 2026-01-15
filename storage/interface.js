/**
 * Storage Adapter Interface
 *
 * Defines the contract between BRI engine and storage backends.
 * Implementations: InHouse adapter
 */

export const DEFAULTS = {
  dataDir: './data',
  memoryTargetPercent: 0.8, // 80% memory target utilization
  evictionThreshold: 0.8,   // Start evicting at 80% of maxMemoryMB
  walSegmentSize: 10 * 1024 * 1024, // 10MB
  fsyncMode: 'batched',
  fsyncIntervalMs: 100,
  snapshotIntervalMs: 30 * 60 * 1000, // 30 minutes
  keepSnapshots: 3
};

/**
 * Validate store configuration
 * @param {Object} config
 * @throws {Error} if required fields are missing
 */
export function validateConfig(config) {
  if (!config.maxMemoryMB || typeof config.maxMemoryMB !== 'number') {
    throw new Error('StoreConfig.maxMemoryMB is required and must be a number');
  }
  if (config.maxMemoryMB <= 0) {
    throw new Error('StoreConfig.maxMemoryMB must be positive');
  }
  return {
    ...DEFAULTS,
    ...config
  };
}
