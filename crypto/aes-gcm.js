/**
 * @file AES-256-GCM Encryption
 *
 * Format: IV (12 bytes) + AuthTag (16 bytes) + Ciphertext
 */

import crypto from 'crypto';
import { AuthenticationError, InvalidKeyError } from './errors.js';

const IV_LENGTH = 12;        // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16;  // 128 bits
const KEY_LENGTH = 32;       // 256 bits

/**
 * Encrypt data with AES-256-GCM
 * @param {Buffer} plaintext - Data to encrypt
 * @param {Buffer} key - 32-byte encryption key
 * @param {Buffer} [aad] - Additional Authenticated Data (optional)
 * @returns {Buffer} IV + AuthTag + Ciphertext
 */
export function encrypt(plaintext, key, aad = Buffer.alloc(0)) {
  if (key.length !== KEY_LENGTH) {
    throw new InvalidKeyError(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  if (aad.length > 0) {
    cipher.setAAD(aad);
  }

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  // Return: IV (12) + AuthTag (16) + Ciphertext
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt data with AES-256-GCM
 * @param {Buffer} encryptedData - IV + AuthTag + Ciphertext
 * @param {Buffer} key - 32-byte encryption key
 * @param {Buffer} [aad] - Additional Authenticated Data (must match encrypt)
 * @returns {Buffer} Plaintext
 */
export function decrypt(encryptedData, key, aad = Buffer.alloc(0)) {
  if (key.length !== KEY_LENGTH) {
    throw new InvalidKeyError(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  if (encryptedData.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new AuthenticationError('Encrypted data too short');
  }

  const iv = encryptedData.subarray(0, IV_LENGTH);
  const authTag = encryptedData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encryptedData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  if (aad.length > 0) {
    decipher.setAAD(aad);
  }

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  } catch (err) {
    if (err.message.includes('Unsupported state') ||
        err.message.includes('authentication')) {
      throw new AuthenticationError('Decryption failed: data tampered or wrong key');
    }
    throw err;
  }
}

export const IV_SIZE = IV_LENGTH;
export const TAG_SIZE = AUTH_TAG_LENGTH;
export const KEY_SIZE = KEY_LENGTH;
