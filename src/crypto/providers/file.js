/**
 * @file File Key Provider
 *
 * Reads encryption key from a local file with permission checks.
 * Supports both raw binary (32 bytes) and hex-encoded (64 chars).
 */

import fs from 'fs/promises';
import { InvalidKeyError, KeyUnavailableError, InsecureKeyFileError } from '../errors.js';

/**
 * Key provider that reads from a local file
 */
export class FileKeyProvider {
  /**
   * Create a file key provider
   * @param {Object} [config={}] - Configuration options
   * @param {string} [config.keyPath='/etc/bri/encryption.key'] - Path to key file
   * @param {boolean} [config.checkPermissions=true] - Verify file permissions
   */
  constructor(config = {}) {
    this.keyPath = config.keyPath || '/etc/bri/encryption.key';
    this.checkPermissions = config.checkPermissions !== false;
  }

  /**
   * Fetch encryption key from file
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: null}>} Key data
   * @throws {KeyUnavailableError} If file not found
   * @throws {InvalidKeyError} If key format is invalid
   * @throws {InsecureKeyFileError} If file permissions are too open
   */
  async fetchKey() {
    // Verify file permissions first
    if (this.checkPermissions) {
      await this.verifyPermissions();
    }

    let keyData;
    try {
      keyData = await fs.readFile(this.keyPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new KeyUnavailableError(`Key file not found: ${this.keyPath}`);
      }
      throw err;
    }

    // Support both raw binary (32 bytes) and hex-encoded (64 chars)
    let key;
    if (keyData.length === 32) {
      key = keyData;
    } else {
      const hex = keyData.toString('utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        key = Buffer.from(hex, 'hex');
      } else {
        throw new InvalidKeyError(
          `Invalid key file: expected 32 bytes or 64 hex characters, got ${keyData.length} bytes`
        );
      }
    }

    return {
      keyId: 'file-static',
      key,
      expiresAt: null
    };
  }

  /**
   * Verify file has secure permissions (0600 or stricter)
   * @throws {KeyUnavailableError} If file not found
   * @throws {InsecureKeyFileError} If permissions allow group/other access
   */
  async verifyPermissions() {
    let stats;
    try {
      stats = await fs.stat(this.keyPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new KeyUnavailableError(`Key file not found: ${this.keyPath}`);
      }
      throw err;
    }

    // Check owner-only permissions (0600 or stricter)
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      throw new InsecureKeyFileError(
        `Key file ${this.keyPath} has insecure permissions: ${mode.toString(8)}. ` +
        `Expected 0600 or stricter (no group/other access).`
      );
    }
  }

  /**
   * Close the provider (no-op for file provider)
   * @returns {Promise<void>}
   */
  async close() {
    // No cleanup needed
  }
}
