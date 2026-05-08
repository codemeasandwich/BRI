/**
 * @file Key Manager
 *
 * Handles encryption key lifecycle with pluggable providers.
 * Must be initialized before database starts - fails fast if key unavailable.
 */

import crypto from 'crypto';
import { KeyUnavailableError } from './errors.js';
import { EnvKeyProvider, FileKeyProvider, RemoteKeyProvider } from './providers/index.js';
import { createBriLogger } from '../observability/logger.js';

/**
 * Manages encryption key lifecycle with pluggable providers
 */
export class KeyManager {
  /**
   * Create a new KeyManager
   * @param {Object} config - Configuration options
   * @param {string} [config.keyProvider='env'] - Provider type: 'env', 'file', or 'remote'
   * @param {Object} [config.keyProviderConfig={}] - Provider-specific configuration
   * @param {number} [config.keyRefreshIntervalMs=0] - Key refresh interval (0 to disable)
   * @param {false|Object} [config.logger] - Bri logger boundary for runtime failures
   */
  constructor(config = {}) {
    this.providerType = config.keyProvider || 'env';
    this.providerConfig = config.keyProviderConfig || {};
    this.refreshIntervalMs = config.keyRefreshIntervalMs || 0;
    this.logger = createBriLogger(config.logger);

    this.provider = null;
    this.currentKey = null;
    this.currentKeyId = null;
    this.refreshTimer = null;
    this.initialized = false;
  }

  /**
   * Initialize key manager - MUST succeed before database starts
   * @throws {KeyUnavailableError} if key cannot be obtained
   */
  async initialize() {
    if (this.initialized) return;

    // Create provider
    this.provider = this._createProvider();

    // Fetch initial key - fail fast if unavailable
    const keyData = await this.provider.fetchKey();
    this.currentKey = keyData.key;
    this.currentKeyId = keyData.keyId;
    this.initialized = true;

    // Start key refresh if configured
    if (this.refreshIntervalMs > 0) {
      this._startRefresh();
    }
  }

  /**
   * Create the appropriate key provider based on configuration
   * @returns {EnvKeyProvider|FileKeyProvider|RemoteKeyProvider} Key provider instance
   * @private
   */
  _createProvider() {
    switch (this.providerType) {
      case 'env':
        return new EnvKeyProvider(this.providerConfig);
      case 'file':
        return new FileKeyProvider(this.providerConfig);
      case 'remote':
        return new RemoteKeyProvider({
          ...this.providerConfig,
          logger: this.logger
        });
      default:
        throw new Error(`Unknown key provider: ${this.providerType}`);
    }
  }

  /**
   * Get current encryption key
   * @returns {Buffer} 32-byte key
   */
  getKey() {
    if (!this.initialized) {
      throw new KeyUnavailableError('KeyManager not initialized');
    }
    return this.currentKey;
  }

  /**
   * Get current key ID
   * @returns {string}
   */
  getKeyId() {
    return this.currentKeyId;
  }

  /**
   * Start automatic key refresh timer
   * @private
   */
  _startRefresh() {
    this.refreshTimer = setInterval(async () => {
      try {
        const keyData = await this.provider.fetchKey();
        this.currentKey = keyData.key;
        this.currentKeyId = keyData.keyId;
      } catch (err) {
        this.logger.error({
          event: 'crypto.key_manager.refresh_failed',
          message: `KeyManager: Key refresh failed: ${err.message}`,
          error: err
        });
      }
    }, this.refreshIntervalMs);

    // Don't block process exit
    this.refreshTimer.unref?.();
  }

  /**
   * Close key manager and securely clear keys
   */
  async close() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Securely clear key from memory
    if (this.currentKey) {
      crypto.randomFillSync(this.currentKey);
      this.currentKey = null;
    }

    if (this.provider?.close) {
      await this.provider.close();
    }

    this.initialized = false;
  }
}
