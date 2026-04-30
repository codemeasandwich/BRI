/**
 * @file Storage Adapter Interface
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

export const ENCRYPTION_DEFAULTS = {
  enabled: false,
  algorithm: 'aes-256-gcm',
  keyProvider: 'env',
  keyProviderConfig: {},
  keyRefreshIntervalMs: 0
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

  // Validate encryption config if present
  let encryption = { ...ENCRYPTION_DEFAULTS };
  if (config.encryption) {
    encryption = validateEncryptionConfig(config.encryption);
  }

  return {
    ...DEFAULTS,
    ...config,
    encryption
  };
}

/**
 * Validate encryption configuration
 * @param {Object} config
 * @returns {Object} validated config with defaults
 */
export function validateEncryptionConfig(config) {
  const valid = {
    ...ENCRYPTION_DEFAULTS,
    ...config
  };

  if (!valid.enabled) {
    return valid;
  }

  if (valid.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported encryption algorithm: ${valid.algorithm}`);
  }

  const validProviders = ['env', 'file', 'remote'];
  if (!validProviders.includes(valid.keyProvider)) {
    throw new Error(
      `Unknown key provider: ${valid.keyProvider}. Valid: ${validProviders.join(', ')}`
    );
  }

  if (valid.keyProvider === 'remote') {
    if (!valid.keyProviderConfig?.endpoint) {
      throw new Error('Remote key provider requires keyProviderConfig.endpoint');
    }
  }

  return valid;
}
