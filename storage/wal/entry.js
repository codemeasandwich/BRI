/**
 * WAL Entry Types
 *
 * Line format: {timestamp}|{pointer}|{entry}
 * - timestamp: Unix timestamp in ms
 * - pointer: hash(prevPointer || "", entry) - chain integrity
 * - entry: JSS-encoded operation data
 */

import JSS from '../../utils/jss/index.js';
import crypto from 'crypto';

export const WALOp = {
  SET: 'SET',
  DELETE: 'DELETE',
  RENAME: 'RENAME',
  SADD: 'SADD',
  SREM: 'SREM'
};

// Hash for pointer chain (8 chars of sha256)
export function hashPointer(prevPointer, entryJson) {
  const input = (prevPointer || '') + entryJson;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function createSetEntry(key, value) {
  return {
    action: WALOp.SET,
    target: key,
    value
  };
}

export function createDeleteEntry(key) {
  return {
    action: WALOp.DELETE,
    target: key
  };
}

export function createRenameEntry(oldKey, newKey) {
  return {
    action: WALOp.RENAME,
    target: newKey,
    oldKey
  };
}

export function createSAddEntry(setName, member) {
  return {
    action: WALOp.SADD,
    target: setName,
    member
  };
}

export function createSRemEntry(setName, member) {
  return {
    action: WALOp.SREM,
    target: setName,
    member
  };
}

// Serialize: {timestamp}|{pointer}|{entry}
export function serializeEntry(entry, prevPointer = null) {
  const timestamp = Date.now();
  const entryJson = JSS.stringify(entry);
  const pointer = hashPointer(prevPointer, entryJson);
  return `${timestamp}|${pointer}|${entryJson}`;
}

// Deserialize line back to entry with metadata
export function deserializeEntry(line) {
  const firstPipe = line.indexOf('|');
  const secondPipe = line.indexOf('|', firstPipe + 1);

  const timestamp = parseInt(line.slice(0, firstPipe), 10);
  const pointer = line.slice(firstPipe + 1, secondPipe);
  const entryJson = line.slice(secondPipe + 1);

  const entry = JSS.parse(entryJson);
  entry._timestamp = new Date(timestamp);
  entry._pointer = pointer;
  entry._entryJson = entryJson;

  return entry;
}
