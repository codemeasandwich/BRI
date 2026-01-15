/**
 * @file Transaction recovery and squash logic
 */

import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import {
  createSetEntry,
  createRenameEntry,
  createSAddEntry,
  deserializeEntry
} from '../wal/entry.js';

/**
 * Creates recovery methods for TransactionManager
 * @returns {Object} Recovery methods
 */
export function createRecoveryMethods() {
  return {
    /**
     * Squash all actions into final state
     * @param {Object} txn - Transaction state
     * @returns {Array} Squashed WAL entries
     */
    squashActions(txn) {
      const squashed = [];

      const txnMeta = {
        txnId: txn.txnId,
        actions: txn.actions.map(a => ({
          action: a.action,
          target: a.target,
          ts: a.ts
        }))
      };

      for (const [key, value] of txn.documents) {
        const entry = createSetEntry(key, value);
        entry.txn = txnMeta;
        squashed.push(entry);
      }

      for (const [oldKey, newKey] of txn.renames) {
        if (!txn.documents.has(newKey)) {
          const entry = createRenameEntry(oldKey, newKey);
          entry.txn = txnMeta;
          squashed.push(entry);
        }
      }

      for (const [setName, members] of txn.collections) {
        for (const member of members) {
          const entry = createSAddEntry(setName, member);
          entry.txn = txnMeta;
          squashed.push(entry);
        }
      }

      return squashed;
    },

    /**
     * Recover pending transactions from disk on startup
     */
    async recover() {
      try {
        const files = await fs.readdir(this.txnDir);
        const walFiles = files.filter(f => f.endsWith('.wal'));

        for (const file of walFiles) {
          const txnId = file.replace('.wal', '');
          const walFile = path.join(this.txnDir, file);

          const txn = {
            txnId,
            walFile,
            documents: new Map(),
            collections: new Map(),
            deletedDocs: new Set(),
            renames: new Map(),
            actions: [],
            lastPointer: null
          };

          try {
            const content = readFileSync(walFile, 'utf8');
            const lines = content.split('\n').filter(l => l.trim());

            for (const line of lines) {
              const entry = deserializeEntry(line);
              txn.lastPointer = entry._pointer;

              switch (entry.action) {
                case 'SET':
                  txn.documents.set(entry.target, entry.value);
                  txn.actions.push(entry);
                  break;
                case 'DELETE':
                  txn.deletedDocs.add(entry.target);
                  txn.actions.push(entry);
                  break;
                case 'RENAME':
                  txn.renames.set(entry.oldKey, entry.target);
                  txn.actions.push(entry);
                  break;
                case 'SADD':
                  if (!txn.collections.has(entry.target)) {
                    txn.collections.set(entry.target, new Set());
                  }
                  txn.collections.get(entry.target).add(entry.member);
                  txn.actions.push(entry);
                  break;
                case 'SREM':
                  txn.collections.get(entry.target)?.delete(entry.member);
                  txn.actions.push(entry);
                  break;
              }
            }
          } catch (err) {
            console.warn(`TransactionManager: Failed to replay ${txnId}:`, err.message);
          }

          this.pending.set(txnId, txn);
          console.log(`TransactionManager: Recovered transaction ${txnId} with ${txn.actions.length} actions`);
        }
      } catch (err) {
        // txn directory might not exist yet
      }
    }
  };
}
