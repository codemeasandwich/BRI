/**
 * @file Encryption-specific errors
 */

/**
 * Base error for all encryption operations
 */
export class EncryptionError extends Error {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * Error when encryption key is not available
 */
export class KeyUnavailableError extends EncryptionError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'KeyUnavailableError';
  }
}

/**
 * Error when remote key service is unavailable
 */
export class KeyServiceUnavailableError extends KeyUnavailableError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'KeyServiceUnavailableError';
  }
}

/**
 * Error when encryption key is invalid
 */
export class InvalidKeyError extends EncryptionError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

/**
 * Error when decryption fails
 */
export class DecryptionError extends EncryptionError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Error when data authentication fails (tampered or wrong key)
 */
export class AuthenticationError extends DecryptionError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Error when key file has insecure permissions
 */
export class InsecureKeyFileError extends EncryptionError {
  /**
   * @param {string} message - Error message
   */
  constructor(message) {
    super(message);
    this.name = 'InsecureKeyFileError';
  }
}
