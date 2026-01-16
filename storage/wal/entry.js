/**
 * @file WAL Entry Types
 *
 * Line format: {timestamp}|{pointer}|{entry}
 * - timestamp: Unix timestamp in ms
 * - pointer: hash(prevPointer || "", entry) - chain integrity
 * - entry: JSS-encoded operation data (encrypted if encryption enabled)
 *
 * Encrypted format: {timestamp}|{pointer}|{base64(IV + AuthTag + Ciphertext)}
 * - AAD (Additional Authenticated Data) = "{timestamp}|{pointer}"
 */

import JSS from '../../utils/jss/index.js';
import crypto from 'crypto';
import * as aesGcm from '../../crypto/aes-gcm.js';

/** WAL operation types */
export const WALOp = {
  SET: 'SET',
  DELETE: 'DELETE',
  RENAME: 'RENAME',
  SADD: 'SADD',
  SREM: 'SREM'
};

/**
 * Hash for pointer chain (8 chars of sha256)
 * @param {string|null} prevPointer - Previous pointer in chain
 * @param {string} entryJson - JSON-stringified entry
 * @returns {string} 8-character hash
 */
export function hashPointer(prevPointer, entryJson) {
  const input = (prevPointer || '') + entryJson;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Create a SET entry
 * @param {string} key - Document key
 * @param {*} value - Document value
 * @returns {Object} WAL entry
 */
export function createSetEntry(key, value) {
  return {
    action: WALOp.SET,
    target: key,
    value
  };
}

/**
 * Create a DELETE entry
 * @param {string} key - Document key
 * @returns {Object} WAL entry
 */
export function createDeleteEntry(key) {
  return {
    action: WALOp.DELETE,
    target: key
  };
}

/**
 * Create a RENAME entry
 * @param {string} oldKey - Original key
 * @param {string} newKey - New key
 * @returns {Object} WAL entry
 */
export function createRenameEntry(oldKey, newKey) {
  return {
    action: WALOp.RENAME,
    target: newKey,
    oldKey
  };
}

/**
 * Create a SADD (set add) entry
 * @param {string} setName - Set name
 * @param {*} member - Member to add
 * @returns {Object} WAL entry
 */
export function createSAddEntry(setName, member) {
  return {
    action: WALOp.SADD,
    target: setName,
    member
  };
}

/**
 * Create a SREM (set remove) entry
 * @param {string} setName - Set name
 * @param {*} member - Member to remove
 * @returns {Object} WAL entry
 */
export function createSRemEntry(setName, member) {
  return {
    action: WALOp.SREM,
    target: setName,
    member
  };
}

/**
 * Serialize entry to WAL line format: {timestamp}|{pointer}|{entry}
 * @param {Object} entry - Entry to serialize
 * @param {string|null} [prevPointer=null] - Previous pointer for chain
 * @returns {string} Serialized line
 */
export function serializeEntry(entry, prevPointer = null) {
  const timestamp = Date.now();
  const entryJson = JSS.stringify(entry);
  const pointer = hashPointer(prevPointer, entryJson);
  return `${timestamp}|${pointer}|${entryJson}`;
}

/**
 * Deserialize WAL line back to entry with metadata
 * @param {string} line - WAL line to deserialize
 * @param {Buffer|null} [encryptionKey=null] - Decryption key if encrypted
 * @returns {Object} Entry with _timestamp, _pointer, _entryJson metadata
 */
export function deserializeEntry(line, encryptionKey = null) {
  const firstPipe = line.indexOf('|');
  const secondPipe = line.indexOf('|', firstPipe + 1);

  const timestamp = parseInt(line.slice(0, firstPipe), 10);
  const pointer = line.slice(firstPipe + 1, secondPipe);
  let entryJson = line.slice(secondPipe + 1);

  // Decrypt if encryption key provided
  if (encryptionKey) {
    const aad = Buffer.from(`${timestamp}|${pointer}`);
    const encrypted = Buffer.from(entryJson, 'base64');
    const decrypted = aesGcm.decrypt(encrypted, encryptionKey, aad);
    entryJson = decrypted.toString('utf8');
  }

  const entry = JSS.parse(entryJson);
  entry._timestamp = new Date(timestamp);
  entry._pointer = pointer;
  entry._entryJson = entryJson;

  return entry;
}

/**
 * Serialize entry with encryption: {timestamp}|{pointer}|{base64(encrypted)}
 * @param {Object} entry - Entry to serialize
 * @param {string|null} [prevPointer=null] - Previous pointer for chain
 * @param {Buffer} encryptionKey - 32-byte encryption key
 * @returns {string} Encrypted serialized line
 */
export function serializeEntryEncrypted(entry, prevPointer = null, encryptionKey) {
  const timestamp = Date.now();
  const entryJson = JSS.stringify(entry);
  const pointer = hashPointer(prevPointer, entryJson);

  // Encrypt entry JSON with AAD binding to timestamp and pointer
  const aad = Buffer.from(`${timestamp}|${pointer}`);
  const encrypted = aesGcm.encrypt(Buffer.from(entryJson, 'utf8'), encryptionKey, aad);

  return `${timestamp}|${pointer}|${encrypted.toString('base64')}`;
}
