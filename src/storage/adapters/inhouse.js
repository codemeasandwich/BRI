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
import { KeyManager } from '../../crypto/key-manager.js';
import { createCrudMethods } from './inhouse-crud.js';
import { createTxnMethods } from './inhouse-txn.js';
import { createRecoveryMethods } from './inhouse-recovery.js';
import JSS from '../../utils/jss/index.js';

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
    this.keyManager = null;

    // Vector registry: collection name -> { schema, index }.
    //
    // Why on the store (not the schema-registry): vector indices outlive the
    // db wrapper that wraps the store, and they need to be populated at
    // recovery time before the user has called db.schema(). The schema-
    // registry (engine/schema-registry.js) consults this map on declare()
    // and shares the same VectorIndex instance for runtime queries.
    //
    // Schema shape: { field: 'embedding', dims: 1536, metric: 'cosine' }.
    this._vectorRegistry = new Map();

    // Persistent GraphIndex (UC-G7 / Persistent GraphIndex):
    //   _graphIndex: live reference set by bindGraphIndex; consulted by
    //     getSnapshotState to serialize adjacency in v4 snapshots.
    //   _pendingGraphState: snapshot-loaded state, drained into the live
    //     index on bind. Null on fresh DB / v3-and-earlier snapshots.
    //   _deferredGraphOps: WAL-replay edge insertions/deletions captured
    //     before the registry is wired. Drained on bindGraphIndex so the
    //     adjacency reflects post-snapshot deltas without losing data.
    //     Required for crash recovery: if the WAL has writes after the
    //     last snapshot, those writes need to apply to the rebuilt index.
    this._graphIndex = null;
    this._pendingGraphState = null;
    this._deferredGraphOps = null;
  }

  /**
   * Register a vector index + schema for a collection.
   *
   * Called by:
   *   - schema-registry.declare() at runtime when a vector field is declared
   *   - inhouse-recovery.js when loading a snapshot that has vector data
   *
   * The store retains the index reference so it can serialize on the next
   * snapshot and so WAL replay can update it before any user-side schema is
   * declared. Subsequent declares for the same collection MUST pass an index
   * that matches the persisted dims/metric — the registry enforces drift
   * detection up the stack.
   *
   * @param {string} collection - Collection name (e.g. 'memoryArtifact')
   * @param {Object} schema - Vector schema; { field: string, dims: number, metric: string }
   * @param {Object} index - VectorIndex instance
   */
  registerVectorIndex(collection, schema, index) {
    this._vectorRegistry.set(collection, { schema, index });
  }

  /**
   * Look up the persisted vector entry for a collection. Returns the entry
   * (with `.schema` and `.index`) if cached, or undefined when this collection
   * has no persisted vector data.
   *
   * @param {string} collection
   * @returns {{schema:Object, index:Object}|undefined}
   */
  getVectorEntry(collection) {
    return this._vectorRegistry.get(collection);
  }

  /**
   * Iterate all registered vector entries. Used by snapshot serialization
   * to capture every collection's index + schema in one pass.
   *
   * @returns {Iterable<[string, {schema:Object, index:Object}]>}
   */
  vectorEntries() {
    return this._vectorRegistry.entries();
  }

  /**
   * Bind the SecondaryIndexManager owned by the schema registry to this
   * store so snapshots can persist its state and recovery can hand its
   * pre-loaded state back to a future registry instance.
   *
   * Why a one-shot bind (instead of per-collection registration like
   * vectors): the manager is a single shared object, not one-per-
   * collection. The store treats it as opaque — serialize() / load() are
   * the only entry points it cares about.
   *
   * @param {Object} mgr - SecondaryIndexManager instance
   */
  bindSecondaryIndexManager(mgr) {
    this._secondaryIndexManager = mgr;
    if (this._pendingSecondaryState) {
      mgr.load(this._pendingSecondaryState);
      this._pendingSecondaryState = null;
    }
  }

  /**
   * Pre-loaded secondary index state from snapshot, surfaced to the registry
   * via createSchemaRegistry's first call. Returns null when no state was
   * loaded (fresh database or v2 snapshot).
   *
   * @returns {Object|null}
   */
  getSecondaryIndexState() {
    return this._pendingSecondaryState || null;
  }

  /**
   * Capture secondary index state during recovery so the registry can pick
   * it up on its first secondaryIndexManager() use. Used by inhouse-recovery.
   *
   * @param {Object} state - serialize() output, or null/undefined for none
   */
  setPendingSecondaryState(state) {
    this._pendingSecondaryState = state || null;
  }

  /**
   * Persistent GraphIndex (UC-G7 / Persistent GraphIndex) — bind the
   * registry-owned GraphIndex to the store so snapshots can persist its
   * adjacency state and recovery can hand it back. Symmetric with
   * `bindSecondaryIndexManager`. Drains any pending state captured during
   * recovery into the live index on bind.
   *
   * Why bind on the store rather than auto-discover: a single GraphIndex
   * instance is shared across all edge collections in one db; the store
   * snapshots it as one POJO. Multiple binds replace the reference (last
   * writer wins) — used by tests that swap registries on the same store.
   *
   * @param {Object} graphIndex - GraphIndex instance from the schema registry
   */
  bindGraphIndex(graphIndex) {
    this._graphIndex = graphIndex;
    if (this._pendingGraphState) {
      graphIndex.load(this._pendingGraphState);
      this._pendingGraphState = null;
    }
    // Drain any WAL-replay edge ops that were buffered before bind.
    if (this._deferredGraphOps && this._deferredGraphOps.length > 0) {
      for (const op of this._deferredGraphOps) {
        if (op.op === 'insert') graphIndex.insertEdge(op.collection, op.doc);
        else if (op.op === 'remove') graphIndex.removeEdge(op.collection, op.doc);
      }
      this._deferredGraphOps = null;
    }
  }

  /**
   * Pre-loaded GraphIndex state from snapshot, surfaced to the registry
   * via bindGraphIndex. Returns null when no state was loaded (fresh
   * database or v3-and-earlier snapshot).
   *
   * @returns {Object|null}
   */
  getPendingGraphState() {
    return this._pendingGraphState || null;
  }

  /**
   * Capture GraphIndex state during recovery so the registry can pick it
   * up on bindGraphIndex. Used by inhouse-recovery on v4 snapshots.
   *
   * @param {Object} state - GraphIndex.serialize() output, or null
   */
  setPendingGraphState(state) {
    this._pendingGraphState = state || null;
  }

  /**
   * Synchronously enumerate hot-tier doc bodies whose $ID prefix matches
   * `prefix` (e.g. `'KGTR'`). Used by the schema-registry's auto-rebuild
   * path on declare() of an edge collection when no persisted graph state
   * is loaded (v3→v4 migration / fresh DB after WAL-only writes).
   *
   * Cold-tier docs are SKIPPED — sync iteration can't await coldLoader.
   * For full-coverage rebuilds that include cold-tier edges, callers
   * should use the async `db.algo.rebuildGraphIndex({collection})`
   * helper instead. For the typical migration case (snapshot just
   * restored, working set in memory), hot-tier coverage is sufficient.
   *
   * Routed via the collection-set (`{prefix}?`) so the iteration is
   * O(|collection|), not O(|all docs|). Bad bodies (JSS parse errors)
   * are silently skipped — the alternative would be a recovery
   * cascade that aborts the boot on a single corrupt edge.
   *
   * @param {string} prefix - 4-char $ID prefix (uppercase)
   * @returns {Array<Object>} parsed doc bodies in arbitrary order
   */
  iterateHotDocsByPrefix(prefix) {
    if (!this.hotTier) return [];
    // The collection-set members store ONLY the suffix (post-`{prefix}_`)
    // portion of the $ID — that's how Bri's $ID-prefix-by-collection set
    // is structured. Reassemble the full $ID before looking up the doc
    // entry, otherwise the get returns undefined.
    const members = this.hotTier.sMembers(`${prefix}?`);
    const out = [];
    for (const member of members) {
      const fullId = `${prefix}_${member}`;
      const entry = this.hotTier.documents.get(fullId);
      if (!entry || entry.cold || !entry.data) continue;
      try { out.push(JSS.parse(entry.data)); } catch (_) { /* skip bad body */ }
    }
    return out;
  }

  /**
   * Async variant of `iterateHotDocsByPrefix` that ALSO loads cold-tier
   * docs via the hot-tier's `coldLoader` (re-promotes them on access,
   * matching the standard read path's behavior). Returns plain POJOs —
   * NO reactive-proxy overhead, NO ref auto-hydration. The PPR
   * algorithm consumes this for the iteration phase: at AC scale
   * (50k triples / 20k entities) the proxy + auto-hydrate cost
   * dominates the perf budget; raw POJOs cut total PPR runtime
   * roughly 3× without sacrificing cold-tier coverage.
   *
   * Why a sibling method instead of replacing the sync version: the
   * sync helper is the right tool for the schema-registry's
   * declare-time auto-rebuild path — declare() is sync and must stay
   * sync. Algorithms that can `await` (PPR, future graph algos) prefer
   * this async variant.
   *
   * @param {string} prefix - 4-char $ID prefix (uppercase)
   * @returns {Promise<Array<Object>>} parsed doc bodies in any order
   */
  async getDocsByPrefix(prefix) {
    if (!this.hotTier) return [];
    const members = this.hotTier.sMembers(`${prefix}?`);
    const out = [];
    for (const member of members) {
      const fullId = `${prefix}_${member}`;
      // hotTier.get is async — handles cold-tier promotion transparently.
      const data = await this.hotTier.get(fullId);
      if (typeof data !== 'string') continue;
      try { out.push(JSS.parse(data)); } catch (_) { /* skip bad body */ }
    }
    return out;
  }

  /**
   * Connect and initialize all subsystems
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.initialized) return;

    const { dataDir, maxMemoryMB, evictionThreshold, encryption } = this.config;

    // Initialize encryption if enabled
    let encryptionKey = null;
    if (encryption?.enabled) {
      this.keyManager = new KeyManager(encryption);
      await this.keyManager.initialize(); // Fails fast if key unavailable
      encryptionKey = this.keyManager.getKey();
      console.log('InHouse Store: Encryption enabled');
    }

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
      segmentSize: this.config.walSegmentSize,
      encryptionKey
    });

    this.snapshots = new SnapshotManager(dataDir, {
      intervalMs: this.config.snapshotIntervalMs,
      keepCount: this.config.keepSnapshots,
      encryptionKey
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

    if (this.keyManager) {
      await this.keyManager.close();
    }

    this.initialized = false;
    console.log('InHouse Store: Disconnected');
  }
}

// Attach CRUD, transaction, and recovery methods
Object.assign(InHouseAdapter.prototype, createCrudMethods());
Object.assign(InHouseAdapter.prototype, createTxnMethods());
Object.assign(InHouseAdapter.prototype, createRecoveryMethods());
