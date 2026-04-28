/**
 * @file Recovery and snapshot methods for InHouseAdapter
 *
 * Snapshot format versions:
 *   v1 - flat documents/collections POJOs with JSS-serialized doc bodies
 *   v2 - same as v1 but with reattached toString/$ID prototypes
 *   v3 - adds vectorIndices (base64 of VectorIndex.serialize()) and
 *        vectorSchemas ({ collection -> { field, dims, metric } }) so a
 *        process restart restores vector capability without re-embedding;
 *        also carries secondaryIndexes (POJO from SecondaryIndexManager.
 *        serialize()) so declared $indexes survive restart
 *
 * Backwards compatibility:
 *   v1/v2 snapshots load as before. The first snapshot written after
 *   startup is v3 (no migration step required). Reading a v3 snapshot in a
 *   build that doesn't know v3 would still work for the documents/collections
 *   keys; the vectorIndices and secondaryIndexes keys would simply be
 *   ignored by older code.
 */

import path from 'path';
import { WALReader } from '../wal/reader.js';
import JSS from '../../utils/jss/index.js';
import { VectorIndex } from '../../engine/vector-index.js';
import { type2Short } from '../../engine/types.js';

/**
 * Creates recovery and snapshot methods for InHouseAdapter
 * @returns {Object} Recovery methods to attach to adapter
 */
export function createRecoveryMethods() {
  return {
    /**
     * Recover state from snapshot and WAL
     * @returns {Promise<void>}
     */
    async recover() {
      const snapshot = await this.snapshots.loadLatest();

      let startLine = 0;

      if (snapshot) {
        if (snapshot.version === 3) {
          this.loadSnapshotV2(snapshot.documents || {}, snapshot.collections || {});
          this.loadVectorState(snapshot.vectorIndices || {}, snapshot.vectorSchemas || {});
          // Stash secondary-index state for the registry to pick up on its
          // first declare() — the manager isn't constructed until then.
          this.setPendingSecondaryState(snapshot.secondaryIndexes || null);
        } else if (snapshot.version === 2) {
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

      // Build a prefix→collection lookup from the registered schemas. Used by
      // WAL replay to route doc updates into the right vector index without
      // a per-record string parse of the schema map.
      const prefixToCollection = new Map();
      for (const [collection, _entry] of this._vectorRegistry) {
        prefixToCollection.set(type2Short(collection), collection);
      }
      /**
       * Route a WAL set record into the matching collection's vector index.
       * @param {string} key - Document $ID
       * @param {string} value - JSS-encoded document body
       */
      const applyVectorWrite = (key, value) => {
        // Extract collection from the $ID prefix; bail if no vector entry.
        const prefix = key.split('_')[0];
        const collection = prefixToCollection.get(prefix);
        if (!collection) return;
        const entry = this._vectorRegistry.get(collection);
        if (!entry) return;
        const doc = JSS.parse(value);
        const vec = doc[entry.schema.field];
        if (Array.isArray(vec)) {
          entry.index.add(key, vec);
        }
      };

      /**
       * Route a WAL delete record into the matching collection's vector index.
       * @param {string} key - Document $ID being deleted
       */
      const applyVectorDelete = (key) => {
        const prefix = key.split('_')[0];
        const collection = prefixToCollection.get(prefix);
        if (!collection) return;
        const entry = this._vectorRegistry.get(collection);
        if (!entry) return;
        entry.index.remove(key);
      };

      const encryptionKey = this.keyManager?.getKey() || null;
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), { encryptionKey });
      await walReader.replay(startLine, {
        onSet: (key, value) => {
          this.hotTier.set(key, value, false);
          applyVectorWrite(key, value);
        },
        onDelete: (key) => {
          this.hotTier.delete(key);
          this.coldTier.deleteDoc(key).catch(() => {});
          applyVectorDelete(key);
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
     * Restore vector indices and schemas from a v3 snapshot payload.
     *
     * Each entry in `serializedIndices` is a base64-encoded buffer produced
     * by VectorIndex.serialize(); we decode and reconstruct via deserialize().
     * The schema POJOs hold the field name, dims, and metric so WAL replay
     * (and later db.schema() validation) can act on them.
     *
     * Vector wire-format compatibility:
     *   The buffer's internal version is independent of the snapshot
     *   version. VectorIndex.deserialize transparently handles both v1
     *   (no graph topology — triggers a one-shot HNSW rebuild from slot
     *   storage at boot) and v2 (HNSW topology installed directly). The
     *   first snapshot written after a v1→v2 upgrade is automatically
     *   v2 because packIndex always emits the current format.
     *
     * @param {Object} serializedIndices - { collection -> base64 string }
     * @param {Object} schemas - { collection -> {field, dims, metric} }
     */
    loadVectorState(serializedIndices, schemas) {
      for (const [collection, schema] of Object.entries(schemas)) {
        const b64 = serializedIndices[collection];
        if (!b64) {
          // Schema declared but no index buffer — should not happen in
          // practice, but tolerate by registering an empty index that
          // matches the persisted shape.
          const empty = new VectorIndex({
            dims: schema.dims, metric: schema.metric || 'cosine'
          });
          this._vectorRegistry.set(collection, { schema, index: empty });
          continue;
        }
        const buf = Buffer.from(b64, 'base64');
        const index = VectorIndex.deserialize(buf);
        this._vectorRegistry.set(collection, { schema, index });
      }
      const count = Object.keys(schemas).length;
      if (count > 0) {
        console.log(`InHouse Store: Loaded vector state for ${count} collection(s)`);
      }
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
     * Get current state for snapshot.
     *
     * Always emits v3 when any vector data is registered, otherwise v2.
     * Why conditional: v3 readers handle v2 snapshots fine, but a v2 snapshot
     * can't carry vector state — so the version reflects the actual payload.
     *
     * @returns {Object} Snapshot state
     */
    async getSnapshotState() {
      const encryptionKey = this.keyManager?.getKey() || null;
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), { encryptionKey });
      const walLine = await walReader.getLineCount();
      const hasVectorState = this._vectorRegistry.size > 0;
      // Secondary state is captured if the manager is bound and has any
      // declared specs. We snapshot proactively so future restarts don't
      // re-declare against an empty manager and silently lose persistence.
      let secondaryState = null;
      if (this._secondaryIndexManager) {
        const ser = this._secondaryIndexManager.serialize();
        if (ser && Object.keys(ser).length > 0) secondaryState = ser;
      }
      const hasV3Payload = hasVectorState || !!secondaryState;
      const base = {
        version: hasV3Payload ? 3 : 2,
        walLine,
        documents: this.hotTier.getAllDocumentsForSnapshot(JSS.parse),
        collections: this.hotTier.getAllCollections()
      };
      if (hasVectorState) {
        const vectorIndices = {};
        const vectorSchemas = {};
        for (const [collection, entry] of this._vectorRegistry) {
          vectorIndices[collection] = entry.index.serialize().toString('base64');
          vectorSchemas[collection] = entry.schema;
        }
        base.vectorIndices = vectorIndices;
        base.vectorSchemas = vectorSchemas;
      }
      if (secondaryState) {
        base.secondaryIndexes = secondaryState;
      }
      return base;
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
