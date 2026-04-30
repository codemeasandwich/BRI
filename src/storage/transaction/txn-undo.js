/**
 * @file Transaction undo/pop functionality
 */

import { readFileSync, writeFileSync } from 'fs';

/**
 * Creates undo methods for TransactionManager
 * @returns {Object} Undo methods
 */
export function createUndoMethods() {
  return {
    /**
     * Pop (undo) the last action in a transaction
     * @param {string} txnId - Transaction ID
     * @returns {Object|null} The popped action, or null if no actions
     */
    async pop(txnId) {
      const txn = this.getTxn(txnId);

      if (txn.actions.length === 0) {
        return null;
      }

      const lastAction = txn.actions.pop();

      // Reverse the action in shadow state
      switch (lastAction.action) {
        case 'SET':
          if (lastAction._prevValue !== undefined) {
            txn.documents.set(lastAction.target, lastAction._prevValue);
          } else {
            txn.documents.delete(lastAction.target);
          }
          break;

        case 'DELETE':
          txn.deletedDocs.delete(lastAction.target);
          break;

        case 'RENAME':
          if (lastAction._prevRenames) {
            txn.renames = lastAction._prevRenames;
          }
          const value = txn.documents.get(lastAction.target);
          if (value !== undefined) {
            txn.documents.delete(lastAction.target);
            txn.documents.set(lastAction.oldKey, value);
          }
          break;

        case 'SADD':
          txn.collections.get(lastAction.target)?.delete(lastAction.member);
          break;

        case 'SREM':
          if (!txn.collections.has(lastAction.target)) {
            txn.collections.set(lastAction.target, new Set());
          }
          txn.collections.get(lastAction.target).add(lastAction.member);
          break;
      }

      // Truncate WAL file (remove last line)
      await this.truncateLastLine(txn.walFile);

      return lastAction;
    },

    /**
     * Remove the last line from a file
     * @param {string} filePath - Path to file
     */
    async truncateLastLine(filePath) {
      try {
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        lines.pop();
        writeFileSync(filePath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
      } catch (err) {
        // File might be empty or not exist
      }
    }
  };
}
