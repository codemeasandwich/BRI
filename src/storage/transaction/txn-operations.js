/**
 * @file Transaction CRUD operations mixin
 */

import {
  createSetEntry,
  createRenameEntry,
  createSAddEntry,
  createSRemEntry,
  serializeEntry
} from '../wal/entry.js';
import { appendFileSync } from 'fs';

/**
 * Creates transaction operation methods for TransactionManager
 * @returns {Object} Transaction operation methods
 */
export function createTxnOperationMethods() {
  return {
    /**
     * Write entry to transaction WAL
     * @param {Object} txn - Transaction state
     * @param {Object} entry - WAL entry
     */
    appendToTxnWal(txn, entry) {
      const line = serializeEntry(entry, txn.lastPointer);
      appendFileSync(txn.walFile, line + '\n', 'utf8');
      const parts = line.split('|');
      txn.lastPointer = parts[1];
    },

    /**
     * Set a document within a transaction
     * @param {string} txnId - Transaction ID
     * @param {string} key - Document key
     * @param {string} value - Serialized value
     */
    set(txnId, key, value) {
      const txn = this.getTxn(txnId);
      const entry = createSetEntry(key, value);

      this.appendToTxnWal(txn, entry);
      txn.actions.push({ ...entry, ts: new Date(), _prevValue: txn.documents.get(key) });

      txn.documents.set(key, value);
      txn.deletedDocs.delete(key);
    },

    /**
     * Get a document from transaction shadow state
     * @param {string} txnId - Transaction ID
     * @param {string} key - Document key
     * @returns {string|null|undefined} Value if in txn, null if deleted, undefined to check main
     */
    get(txnId, key) {
      const txn = this.getTxn(txnId);

      if (txn.deletedDocs.has(key)) {
        return null;
      }

      if (txn.documents.has(key)) {
        return txn.documents.get(key);
      }

      for (const [oldKey, newKey] of txn.renames) {
        if (newKey === key) {
          return txn.documents.get(key);
        }
      }

      return undefined;
    },

    /**
     * Rename a key within a transaction
     * @param {string} txnId - Transaction ID
     * @param {string} oldKey - Current key
     * @param {string} newKey - New key
     */
    rename(txnId, oldKey, newKey) {
      const txn = this.getTxn(txnId);
      const entry = createRenameEntry(oldKey, newKey);

      this.appendToTxnWal(txn, entry);
      txn.actions.push({ ...entry, ts: new Date(), _prevRenames: new Map(txn.renames) });

      const value = txn.documents.get(oldKey);
      if (value !== undefined) {
        txn.documents.delete(oldKey);
        txn.documents.set(newKey, value);
      }
      txn.renames.set(oldKey, newKey);
    },

    /**
     * Add member to set within a transaction
     * @param {string} txnId - Transaction ID
     * @param {string} setName - Set name
     * @param {string} member - Member to add
     */
    sAdd(txnId, setName, member) {
      const txn = this.getTxn(txnId);
      const entry = createSAddEntry(setName, member);

      this.appendToTxnWal(txn, entry);
      txn.actions.push({ ...entry, ts: new Date() });

      if (!txn.collections.has(setName)) {
        txn.collections.set(setName, new Set());
      }
      txn.collections.get(setName).add(member);
    },

    /**
     * Get set members from transaction
     * @param {string} txnId - Transaction ID
     * @param {string} setName - Set name
     * @returns {Set} Transaction additions for this set
     */
    sMembers(txnId, setName) {
      const txn = this.getTxn(txnId);
      return txn.collections.get(setName) || new Set();
    },

    /**
     * Remove member from set within a transaction
     * @param {string} txnId - Transaction ID
     * @param {string} setName - Set name
     * @param {string} member - Member to remove
     */
    sRem(txnId, setName, member) {
      const txn = this.getTxn(txnId);
      const entry = createSRemEntry(setName, member);

      this.appendToTxnWal(txn, entry);
      txn.actions.push({ ...entry, ts: new Date() });

      txn.collections.get(setName)?.delete(member);
    }
  };
}
