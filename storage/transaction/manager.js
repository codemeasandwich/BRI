/**
 * @file Transaction Manager - Long-lived hidden transactions
 * Provides rec/fin/nop/pop API for atomic operations
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { createTxnOperationMethods } from './txn-operations.js';
import { createUndoMethods } from './txn-undo.js';
import { createRecoveryMethods } from './txn-recovery.js';

/**
 * Manages long-lived transactions with WAL-based durability
 */
export class TransactionManager {
  /**
   * Creates a new TransactionManager
   * @param {string} dataDir - Data directory path
   */
  constructor(dataDir) {
    this.txnDir = path.join(dataDir, 'txn');
    this.pending = new Map();

    if (!existsSync(this.txnDir)) {
      mkdirSync(this.txnDir, { recursive: true });
    }
  }

  /**
   * Generate a transaction ID
   * @returns {string} Transaction ID
   */
  generateTxnId() {
    const chars = '0123456789abcdefghjkmnpqrtuvwxyz';
    let result = '';
    for (let i = 0; i < 7; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `txn_${result}`;
  }

  /**
   * Start recording a new transaction
   * @returns {string} Transaction ID
   */
  rec() {
    const txnId = this.generateTxnId();
    const walFile = path.join(this.txnDir, `${txnId}.wal`);

    this.pending.set(txnId, {
      txnId,
      walFile,
      documents: new Map(),
      collections: new Map(),
      deletedDocs: new Set(),
      renames: new Map(),
      actions: [],
      lastPointer: null
    });

    writeFileSync(walFile, '', 'utf8');
    return txnId;
  }

  /**
   * Get transaction state (or throw if not found)
   * @param {string} txnId - Transaction ID
   * @returns {Object} Transaction state
   */
  getTxn(txnId) {
    const txn = this.pending.get(txnId);
    if (!txn) {
      throw new Error(`Transaction not found: ${txnId}`);
    }
    return txn;
  }

  /**
   * Check if a transaction exists
   * @param {string} txnId - Transaction ID
   * @returns {boolean} True if exists
   */
  hasTxn(txnId) {
    return this.pending.has(txnId);
  }

  /**
   * Commit transaction - squash and return entries for main store
   * @param {string} txnId - Transaction ID
   * @returns {Object} { entries, documents, collections }
   */
  async fin(txnId) {
    const txn = this.getTxn(txnId);

    const result = {
      entries: this.squashActions(txn),
      documents: txn.documents,
      collections: txn.collections
    };

    await fs.unlink(txn.walFile).catch(() => {});
    this.pending.delete(txnId);

    return result;
  }

  /**
   * Cancel transaction - discard all changes
   * @param {string} txnId - Transaction ID
   */
  async nop(txnId) {
    const txn = this.pending.get(txnId);
    if (!txn) return;

    await fs.unlink(txn.walFile).catch(() => {});
    this.pending.delete(txnId);
  }

  /**
   * Get transaction status
   * @param {string} txnId - Transaction ID
   * @returns {Object} Status object
   */
  status(txnId) {
    const txn = this.pending.get(txnId);
    if (!txn) {
      return { exists: false };
    }

    return {
      exists: true,
      txnId,
      actionCount: txn.actions.length,
      documentCount: txn.documents.size,
      collectionCount: txn.collections.size,
      createdAt: txn.actions[0]?.ts || null
    };
  }

  /**
   * List all pending transactions
   * @returns {Array<string>} Transaction IDs
   */
  listPending() {
    return Array.from(this.pending.keys());
  }

  /**
   * Clean up (call on shutdown)
   */
  async close() {
    // Nothing to do - transactions remain on disk for recovery
  }
}

// Attach operation, undo, and recovery methods
Object.assign(TransactionManager.prototype, createTxnOperationMethods());
Object.assign(TransactionManager.prototype, createUndoMethods());
Object.assign(TransactionManager.prototype, createRecoveryMethods());
