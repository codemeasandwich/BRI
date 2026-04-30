/**
 * @file Environment Variable Key Provider
 *
 * Reads encryption key from environment variable.
 * Key must be hex-encoded (64 characters for 32 bytes).
 */

import { InvalidKeyError, KeyUnavailableError } from '../errors.js';

/**
 * Key provider that reads from environment variables
 */
export class EnvKeyProvider {
  /**
   * Create an environment key provider
   * @param {Object} [config={}] - Configuration options
   * @param {string} [config.envVar='BRI_ENCRYPTION_KEY'] - Environment variable name
   */
  constructor(config = {}) {
    this.envVar = config.envVar || 'BRI_ENCRYPTION_KEY';
  }

  /**
   * Fetch encryption key from environment variable
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: null}>} Key data
   * @throws {KeyUnavailableError} If environment variable is not set
   * @throws {InvalidKeyError} If key is not valid hex format
   */
  async fetchKey() {
    const keyHex = process.env[this.envVar];

    if (!keyHex) {
      throw new KeyUnavailableError(`Environment variable ${this.envVar} not set`);
    }

    // Expect hex-encoded 32-byte key (64 hex chars)
    const trimmed = keyHex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new InvalidKeyError(
        `Key in ${this.envVar} must be 64 hex characters (32 bytes)`
      );
    }

    return {
      keyId: 'env-static',
      key: Buffer.from(trimmed, 'hex'),
      expiresAt: null
    };
  }

  /**
   * Close the provider (no-op for env provider)
   * @returns {Promise<void>}
   */
  async close() {
    // No cleanup needed
  }
}
