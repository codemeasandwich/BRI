/**
 * @file InHouse Storage Adapter - Main coordinator
 * Memory-first architecture with WAL for durability
 */

import path from 'path';
import { validateConfig } from '../interface.js';
import { HotTierCache } from '../hot-tier/cache.js';
import { WALWriter } from '../wal/writer.js';
import { ColdTierFiles } from '../cold-tier/files.js';
import { SnapshotManager } from '../snapshot/manager.js';
import { LocalPubSub } from '../pubsub/local.js';
import { TransactionManager } from '../transaction/manager.js';
import { createCrudMethods } from './inhouse-crud.js';
import { createTxnMethods } from './inhouse-txn.js';
import { createRecoveryMethods } from './inhouse-recovery.js';

/**
 * InHouse storage adapter with hot/cold tier and transactions
 */
export class InHouseAdapter {
  /**
   * Creates a new InHouseAdapter
   * @param {Object} config - Configuration options
   */
  constructor(config) {
    this.config = validateConfig(config);
    this.initialized = false;

    this.hotTier = null;
    this.wal = null;
    this.coldTier = null;
    this.snapshots = null;
    this.pubsub = null;
    this.txnManager = null;
  }

  /**
   * Connect and initialize all subsystems
   */
  async connect() {
    if (this.initialized) return;

    const { dataDir, maxMemoryMB, evictionThreshold } = this.config;

    this.coldTier = new ColdTierFiles(dataDir);

    this.hotTier = new HotTierCache({
      maxMemoryMB,
      evictionThreshold,
      onEvict: async (key, value) => {
        await this.coldTier.writeDoc(key, value);
      },
      coldLoader: async (key) => {
        const value = await this.coldTier.readDoc(key);
        if (value !== null) {
          await this.coldTier.deleteDoc(key);
        }
        return value;
      }
    });

    this.wal = new WALWriter(path.join(dataDir, 'wal'), {
      fsyncMode: this.config.fsyncMode,
      fsyncIntervalMs: this.config.fsyncIntervalMs,
      segmentSize: this.config.walSegmentSize
    });

    this.snapshots = new SnapshotManager(dataDir, {
      intervalMs: this.config.snapshotIntervalMs,
      keepCount: this.config.keepSnapshots
    });

    this.pubsub = new LocalPubSub();
    this.txnManager = new TransactionManager(dataDir);

    await this.recover();
    this.snapshots.startScheduler(() => this.createSnapshot());

    this.initialized = true;
    console.log('InHouse Store: Connected and ready');
  }

  /**
   * Publish a message to a channel
   * @param {string} channel - Channel name
   * @param {string} message - Message to publish
   */
  async publish(channel, message) {
    await this.pubsub.publish(channel, message);
  }

  /**
   * Subscribe to a channel
   * @param {string} channel - Channel name
   * @param {Function} callback - Callback for messages
   */
  async subscribe(channel, callback) {
    await this.pubsub.subscribe(channel, callback);
  }

  /**
   * Unsubscribe from a channel
   * @param {string} channel - Channel name
   * @param {Function} callback - Callback to remove
   */
  async unsubscribe(channel, callback) {
    await this.pubsub.unsubscribe(channel, callback);
  }

  /**
   * Get storage statistics
   * @returns {Object} Stats from all subsystems
   */
  async getStats() {
    return {
      hotTier: this.hotTier.getStats(),
      coldTier: await this.coldTier.getStats(),
      snapshots: await this.snapshots.getStats()
    };
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect() {
    if (!this.initialized) return;

    this.snapshots.stopScheduler();

    try {
      await this.createSnapshot();
    } catch (err) {
      console.error('InHouse Store: Final snapshot failed:', err);
    }

    await this.wal.close();
    this.pubsub.clear();

    this.initialized = false;
    console.log('InHouse Store: Disconnected');
  }
}

// Attach CRUD, transaction, and recovery methods
Object.assign(InHouseAdapter.prototype, createCrudMethods());
Object.assign(InHouseAdapter.prototype, createTxnMethods());
Object.assign(InHouseAdapter.prototype, createRecoveryMethods());
