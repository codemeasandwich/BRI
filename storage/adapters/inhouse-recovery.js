/**
 * @file Recovery and snapshot methods for InHouseAdapter
 */

import path from 'path';
import { WALReader } from '../wal/reader.js';
import JSS from '../../utils/jss/index.js';

/**
 * Creates recovery and snapshot methods for InHouseAdapter
 * @returns {Object} Recovery methods to attach to adapter
 */
export function createRecoveryMethods() {
  return {
    /**
     * Recover state from snapshot and WAL
     */
    async recover() {
      const snapshot = await this.snapshots.loadLatest();

      let startLine = 0;

      if (snapshot) {
        if (snapshot.version === 2) {
          this.loadSnapshotV2(snapshot.documents || {}, snapshot.collections || {});
        } else {
          this.hotTier.loadDocuments(snapshot.documents || {});
          this.hotTier.loadCollections(snapshot.collections || {});
        }
        startLine = snapshot.walLine || 0;
      }

      // Load any cold documents as cold references
      const coldDocs = await this.coldTier.listDocs();
      for (const key of coldDocs) {
        if (!this.hotTier.has(key)) {
          this.hotTier.documents.set(key, { cold: true, key });
        }
      }

      await this.wal.init();

      const encryptionKey = this.keyManager?.getKey() || null;
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), { encryptionKey });
      await walReader.replay(startLine, {
        onSet: (key, value) => {
          this.hotTier.set(key, value, false);
        },
        onDelete: (key) => {
          this.hotTier.delete(key);
          this.coldTier.deleteDoc(key).catch(() => {});
        },
        onRename: (oldKey, newKey) => {
          this.hotTier.rename(oldKey, newKey);
        },
        onSAdd: (setName, member) => {
          this.hotTier.sAdd(setName, member);
        },
        onSRem: (setName, member) => {
          this.hotTier.sRem(setName, member);
        }
      });

      await this.txnManager.recover();
      console.log('InHouse Store: Recovered');
    },

    /**
     * Load v2 snapshot format with resolved object references
     * @param {Object} documents - Document objects
     * @param {Object} collections - Collection objects
     */
    loadSnapshotV2(documents, collections) {
      const reattachToString = (obj, visited = new WeakSet()) => {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);

        if (obj.$ID) {
          const $ID = obj.$ID;
          Object.setPrototypeOf(obj, {
            toString: () => $ID,
            toObject: () => obj
          });
        }

        for (const value of Object.values(obj)) {
          if (typeof value === 'object' && value !== null) {
            reattachToString(value, visited);
          }
        }
      };

      for (const doc of Object.values(documents)) {
        reattachToString(doc);
      }

      for (const [$ID, doc] of Object.entries(documents)) {
        this.hotTier.set($ID, JSS.stringify(doc), false);
      }

      this.hotTier.loadCollections(collections);
      console.log(`InHouse Store: Loaded v2 snapshot with ${Object.keys(documents).length} documents`);
    },

    /**
     * Get current state for snapshot
     * @returns {Object} Snapshot state
     */
    async getSnapshotState() {
      const encryptionKey = this.keyManager?.getKey() || null;
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), { encryptionKey });
      const walLine = await walReader.getLineCount();
      return {
        version: 2,
        walLine,
        documents: this.hotTier.getAllDocumentsForSnapshot(JSS.parse),
        collections: this.hotTier.getAllCollections()
      };
    },

    /**
     * Create a snapshot and rotate WAL
     * @returns {string|null} Snapshot path
     */
    async createSnapshot() {
      const state = await this.getSnapshotState();
      const snapshotPath = await this.snapshots.create(state);

      if (snapshotPath) {
        await this.wal.archive();
      }

      return snapshotPath;
    }
  };
}
