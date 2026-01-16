/**
 * @file Snapshot Manager - Single snapshot.jss file for fast recovery
 *
 * - Single file: /data/snapshot.jss (replaced on each snapshot)
 * - Uses JSS format for proper type serialization
 * - Interval: every 30 minutes (configurable)
 * - Supports encryption: file content is base64(IV + AuthTag + Ciphertext)
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import JSS from '../../utils/jss/index.js';
import * as aesGcm from '../../crypto/aes-gcm.js';

/**
 * Manages point-in-time snapshots for fast recovery
 */
export class SnapshotManager {
  /**
   * Create a snapshot manager
   * @param {string} dataDir - Data directory path
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.intervalMs=1800000] - Snapshot interval in ms
   * @param {Buffer} [options.encryptionKey=null] - 32-byte encryption key
   */
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.snapshotPath = path.join(dataDir, 'snapshot.jss');
    this.intervalMs = options.intervalMs || 30 * 60 * 1000;
    this.encryptionKey = options.encryptionKey || null; // 32-byte key or null

    this.timer = null;
    this.isCreating = false;
  }

  /**
   * Create a new snapshot
   * @param {Object} state - State to snapshot
   * @param {number} state.walLine - Current WAL line number
   * @param {Object} state.documents - Document data
   * @param {Object} state.collections - Collection indexes
   * @returns {Promise<string|null>} Snapshot path or null if skipped
   */
  async create(state) {
    if (this.isCreating) {
      console.log('Snapshot: Creation already in progress, skipping');
      return null;
    }

    this.isCreating = true;

    try {
      const timestamp = Date.now();
      const snapshot = {
        version: state.version || 1,
        walLine: state.walLine,
        timestamp: new Date(timestamp),
        documents: state.documents,
        collections: state.collections
      };

      const tempPath = this.snapshotPath + '.tmp';

      let content = JSS.stringify(snapshot);

      // Encrypt if key provided
      if (this.encryptionKey) {
        const encrypted = aesGcm.encrypt(Buffer.from(content, 'utf8'), this.encryptionKey);
        content = encrypted.toString('base64');
      }

      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, this.snapshotPath);

      console.log(`Snapshot: Created at WAL line ${state.walLine}`);

      return this.snapshotPath;
    } finally {
      this.isCreating = false;
    }
  }

  /**
   * Load the latest snapshot
   * @returns {Promise<Object|null>} Snapshot data or null if not found
   */
  async loadLatest() {
    if (!existsSync(this.snapshotPath)) {
      console.log('Snapshot: No snapshot found');
      return null;
    }

    try {
      let content = await fs.readFile(this.snapshotPath, 'utf8');

      // Decrypt if key provided
      if (this.encryptionKey) {
        const encrypted = Buffer.from(content, 'base64');
        content = aesGcm.decrypt(encrypted, this.encryptionKey).toString('utf8');
      }

      const snapshot = JSS.parse(content);

      console.log(`Snapshot: Loaded (WAL line ${snapshot.walLine})`);

      return snapshot;
    } catch (err) {
      console.error(`Snapshot: Failed to load:`, err);
      return null;
    }
  }

  /**
   * Start automatic snapshot scheduler
   * @param {Function} createSnapshot - Callback to create snapshot
   */
  startScheduler(createSnapshot) {
    if (this.timer) {
      return;
    }

    console.log(`Snapshot: Scheduler started (every ${this.intervalMs / 1000 / 60} minutes)`);

    this.timer = setInterval(async () => {
      try {
        await createSnapshot();
      } catch (err) {
        console.error('Snapshot: Scheduled creation failed:', err);
      }
    }, this.intervalMs);
  }

  /**
   * Stop the snapshot scheduler
   */
  stopScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('Snapshot: Scheduler stopped');
    }
  }

  /**
   * Get snapshot statistics
   * @returns {Promise<Object>} Stats including exists, sizeMB, walLine, timestamp
   */
  async getStats() {
    try {
      const stat = await fs.stat(this.snapshotPath);
      let content = await fs.readFile(this.snapshotPath, 'utf8');

      // Decrypt if key provided
      if (this.encryptionKey) {
        const encrypted = Buffer.from(content, 'base64');
        content = aesGcm.decrypt(encrypted, this.encryptionKey).toString('utf8');
      }

      const snapshot = JSS.parse(content);

      return {
        exists: true,
        sizeMB: Math.round(stat.size / 1024 / 1024 * 100) / 100,
        walLine: snapshot.walLine,
        timestamp: snapshot.timestamp
      };
    } catch (err) {
      return {
        exists: false,
        sizeMB: 0,
        walLine: null,
        timestamp: null
      };
    }
  }
}
