/**
 * @file Transaction API mixin for InHouseAdapter
 */

/**
 * Creates transaction API methods for InHouseAdapter
 * @returns {Object} Transaction methods to attach to adapter
 */
export function createTxnMethods() {
  return {
    /**
     * Start recording a new transaction
     * @returns {string} Transaction ID
     */
    rec() {
      return this.txnManager.rec();
    },

    /**
     * Commit transaction - squash and apply to main store
     * @param {string} txnId - Transaction ID
     */
    async fin(txnId) {
      const { entries, documents, collections } = await this.txnManager.fin(txnId);

      // Write squashed entries to main WAL
      for (const entry of entries) {
        await this.wal.append(entry);
      }

      // Apply to main in-memory store
      for (const [key, value] of documents) {
        await this.hotTier.set(key, value, false);
      }
      for (const [setName, members] of collections) {
        for (const member of members) {
          this.hotTier.sAdd(setName, member);
        }
      }

      // Publish changes (now visible to subscribers)
      for (const entry of entries) {
        if (entry.action === 'SET') {
          const type = entry.target.split('_')[0];
          await this.pubsub.publish(type, JSON.stringify({
            action: 'SET',
            target: entry.target,
            value: entry.value
          }));
        }
      }
    },

    /**
     * Cancel transaction - discard all changes
     * @param {string} txnId - Transaction ID
     */
    async nop(txnId) {
      await this.txnManager.nop(txnId);
    },

    /**
     * Pop (undo) the last action in a transaction
     * @param {string} txnId - Transaction ID
     * @returns {Object|null} The popped action
     */
    async pop(txnId) {
      return await this.txnManager.pop(txnId);
    },

    /**
     * Get transaction status
     * @param {string} txnId - Transaction ID
     * @returns {Object} Transaction status
     */
    txnStatus(txnId) {
      return this.txnManager.status(txnId);
    },

    /**
     * List all pending transactions
     * @returns {Array} Pending transaction IDs
     */
    listPendingTxns() {
      return this.txnManager.listPending();
    }
  };
}
