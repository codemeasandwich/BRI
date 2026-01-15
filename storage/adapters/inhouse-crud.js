/**
 * @file CRUD operations mixin for InHouseAdapter
 */

import {
  createSetEntry,
  createRenameEntry,
  createSAddEntry,
  createSRemEntry
} from '../wal/entry.js';

/**
 * Creates CRUD operation methods for InHouseAdapter
 * @returns {Object} CRUD methods to attach to adapter
 */
export function createCrudMethods() {
  return {
    /**
     * Set a key-value pair
     * @param {string} key - Document key
     * @param {string} value - Serialized value
     * @param {Object} options - Options including txnId
     */
    async set(key, value, options = {}) {
      const { txnId } = options;

      if (txnId) {
        this.txnManager.set(txnId, key, value);
        return;
      }

      const entry = createSetEntry(key, value);
      await this.wal.append(entry);
      await this.hotTier.set(key, value, false);
    },

    /**
     * Get a value by key
     * @param {string} key - Document key
     * @param {Object} options - Options including txnId
     * @returns {Promise<string|null>} The value or null
     */
    async get(key, options = {}) {
      const { txnId } = options;

      if (txnId && this.txnManager.hasTxn(txnId)) {
        const txnValue = this.txnManager.get(txnId, key);
        if (txnValue !== undefined) {
          return txnValue;
        }
      }

      return await this.hotTier.get(key);
    },

    /**
     * Rename a key
     * @param {string} oldKey - Current key
     * @param {string} newKey - New key
     * @param {Object} options - Options including txnId
     */
    async rename(oldKey, newKey, options = {}) {
      const { txnId } = options;

      if (txnId) {
        this.txnManager.rename(txnId, oldKey, newKey);
        return;
      }

      const entry = createRenameEntry(oldKey, newKey);
      await this.wal.append(entry);
      this.hotTier.rename(oldKey, newKey);
    },

    /**
     * Add member to a set
     * @param {string} setName - Set name
     * @param {string} member - Member to add
     * @param {Object} options - Options including txnId
     */
    async sAdd(setName, member, options = {}) {
      const { txnId } = options;

      if (txnId) {
        this.txnManager.sAdd(txnId, setName, member);
        return;
      }

      const entry = createSAddEntry(setName, member);
      await this.wal.append(entry);
      this.hotTier.sAdd(setName, member);
    },

    /**
     * Get all members of a set
     * @param {string} setName - Set name
     * @param {Object} options - Options including txnId
     * @returns {Array<string>} Members
     */
    async sMembers(setName, options = {}) {
      const { txnId } = options;

      if (txnId && this.txnManager.hasTxn(txnId)) {
        const mainMembers = this.hotTier.sMembers(setName);
        const txnMembers = this.txnManager.sMembers(txnId, setName);
        return [...new Set([...mainMembers, ...txnMembers])];
      }

      return this.hotTier.sMembers(setName);
    },

    /**
     * Remove member from a set
     * @param {string} setName - Set name
     * @param {string} member - Member to remove
     * @param {Object} options - Options including txnId
     */
    async sRem(setName, member, options = {}) {
      const { txnId } = options;

      if (txnId) {
        this.txnManager.sRem(txnId, setName, member);
        return;
      }

      const entry = createSRemEntry(setName, member);
      await this.wal.append(entry);
      this.hotTier.sRem(setName, member);
    }
  };
}
