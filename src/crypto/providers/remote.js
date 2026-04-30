/**
 * @file Remote Key Provider
 *
 * Fetches encryption key from an external HTTPS service.
 * Fails fast if service is unavailable (no fallback).
 */

import https from 'https';
import { InvalidKeyError, KeyServiceUnavailableError } from '../errors.js';

/**
 * Key provider that fetches from a remote HTTPS service
 */
export class RemoteKeyProvider {
  /**
   * Create a remote key provider
   * @param {Object} config - Configuration options
   * @param {string} config.endpoint - HTTPS endpoint URL
   * @param {string} [config.authToken] - Bearer token for authentication
   * @param {number} [config.timeout=10000] - Request timeout in ms
   * @param {number} [config.retryAttempts=3] - Number of retry attempts
   * @param {number} [config.retryDelayMs=1000] - Base delay between retries
   * @param {Object} [config.mtls] - mTLS configuration {cert, key, ca}
   */
  constructor(config = {}) {
    if (!config.endpoint) {
      throw new Error('RemoteKeyProvider requires endpoint configuration');
    }
    this.endpoint = config.endpoint;
    this.authToken = config.authToken;
    this.timeout = config.timeout || 10000;
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelayMs = config.retryDelayMs || 1000;
    this.mtls = config.mtls || null; // { cert, key, ca }
  }

  /**
   * Fetch encryption key from remote service
   * @param {string} [keyId='current'] - Key identifier to fetch
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: Date|null}>} Key data
   * @throws {KeyServiceUnavailableError} If service is unavailable after retries
   */
  async fetchKey(keyId = 'current') {
    let lastError;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await this._doFetch(keyId);
      } catch (err) {
        lastError = err;
        console.warn(`KeyProvider: Fetch attempt ${attempt}/${this.retryAttempts} failed:`, err.message);

        if (attempt < this.retryAttempts) {
          await this._delay(this.retryDelayMs * attempt);
        }
      }
    }

    throw new KeyServiceUnavailableError(
      `Failed to fetch key after ${this.retryAttempts} attempts: ${lastError.message}`
    );
  }

  /**
   * Perform a single fetch attempt
   * @param {string} keyId - Key identifier
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: Date|null}>} Key data
   * @private
   */
  async _doFetch(keyId) {
    const url = `${this.endpoint}/keys/${keyId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const fetchOptions = {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: controller.signal
    };

    if (this.authToken) {
      fetchOptions.headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    // Add mTLS agent if configured
    if (this.mtls) {
      fetchOptions.agent = new https.Agent({
        cert: this.mtls.cert,
        key: this.mtls.key,
        ca: this.mtls.ca
      });
    }

    try {
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const data = await response.json();

      if (!data.key) {
        throw new InvalidKeyError('Key service response missing "key" field');
      }

      const key = Buffer.from(data.key, 'base64');
      if (key.length !== 32) {
        throw new InvalidKeyError(`Key must be 32 bytes, got ${key.length}`);
      }

      return {
        keyId: data.keyId || keyId,
        key,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Delay for specified milliseconds
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Close the provider (no-op for remote provider)
   * @returns {Promise<void>}
   */
  async close() {
    // No cleanup needed
  }
}
