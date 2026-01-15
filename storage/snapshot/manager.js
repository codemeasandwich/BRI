/**
 * Snapshot Manager - Single snapshot.jss file for fast recovery
 *
 * - Single file: /data/snapshot.jss (replaced on each snapshot)
 * - Uses JSS format for proper type serialization
 * - Interval: every 30 minutes (configurable)
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import JSS from '../../utils/jss/index.js';

export class SnapshotManager {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.snapshotPath = path.join(dataDir, 'snapshot.jss');
    this.intervalMs = options.intervalMs || 30 * 60 * 1000;

    this.timer = null;
    this.isCreating = false;
  }

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

      await fs.writeFile(tempPath, JSS.stringify(snapshot), 'utf8');
      await fs.rename(tempPath, this.snapshotPath);

      console.log(`Snapshot: Created at WAL line ${state.walLine}`);

      return this.snapshotPath;
    } finally {
      this.isCreating = false;
    }
  }

  async loadLatest() {
    if (!existsSync(this.snapshotPath)) {
      console.log('Snapshot: No snapshot found');
      return null;
    }

    try {
      const content = await fs.readFile(this.snapshotPath, 'utf8');
      const snapshot = JSS.parse(content);

      console.log(`Snapshot: Loaded (WAL line ${snapshot.walLine})`);

      return snapshot;
    } catch (err) {
      console.error(`Snapshot: Failed to load:`, err);
      return null;
    }
  }

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

  stopScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('Snapshot: Scheduler stopped');
    }
  }

  async getStats() {
    try {
      const stat = await fs.stat(this.snapshotPath);
      const content = await fs.readFile(this.snapshotPath, 'utf8');
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
