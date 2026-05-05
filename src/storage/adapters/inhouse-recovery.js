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
import { attachToString } from '../../engine/helpers.js';
import {
  buildPrefixToVectorCollectionMap,
  removeFromVectorIndicesForKey
} from './inhouse-vector-wal-route.js';
// Persistent GraphIndex (UC-G7): mirror prefix→edge-collection map.
import { buildPrefixToEdgeCollectionMap } from './inhouse-graph-wal-route.js';

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
        if (snapshot.version === 4) {
          // v4: documents + vector + secondary indexes + GraphIndex state.
          // Forward-compat: every v3 field is still present; v4 adds
          // graphIndices for persistent adjacency (UC-G7 / Persistent
          // GraphIndex).
          this.loadSnapshotV2(snapshot.documents || {}, snapshot.collections || {});
          this.loadVectorState(snapshot.vectorIndices || {}, snapshot.vectorSchemas || {});
          this.setPendingSecondaryState(snapshot.secondaryIndexes || null);
          this.setPendingGraphState(snapshot.graphIndices || null);
        } else if (snapshot.version === 3) {
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

      // Build a prefix→collection lookup from registered vector collections.
      // Shared with hardDelete() via inhouse-vector-wal-route.js so replay and
      // live WAL DELETE stay consistent.
      const prefixToCollection = buildPrefixToVectorCollectionMap(this._vectorRegistry);

      /* Persistent GraphIndex (UC-G7) — build a prefix→{collection, edgeSpec}
       * map from the loaded graph state's persisted specs. WAL records that
       * touch an edge collection are buffered into _deferredGraphOps so the
       * adjacency reflects post-snapshot deltas after bindGraphIndex drains
       * them. When no graph state was loaded (fresh DB / v3-and-earlier),
       * the map is empty and the buffering path is a no-op — the registry's
       * declare-time auto-rebuild handles that case. */
      const graphPrefixMap = buildPrefixToEdgeCollectionMap(this._pendingGraphState);
      if (graphPrefixMap.size > 0) this._deferredGraphOps = [];
      /**
       * Buffer an edge insertion for later replay into the GraphIndex.
       * Identifies the edge collection from the doc's $ID prefix; bails
       * if no matching edge spec is loaded.
       * @param {string} key - Document $ID
       * @param {string} value - JSS-encoded body
       */
      const applyGraphWrite = (key, value) => {
        const prefix = key.split('_')[0];
        const entry = graphPrefixMap.get(prefix);
        if (!entry) return;
        const doc = JSS.parse(value);
        this._deferredGraphOps.push({ op: 'insert', collection: entry.collection, doc });
      };
      /**
       * Buffer an edge deletion for later replay. Must capture the doc
       * body BEFORE the hotTier.delete fires (otherwise GraphIndex's
       * removeEdge can't read endpoint fields to identify which buckets
       * to clean). The MUST-fire-before-delete ordering is enforced in
       * the onDelete callback below.
       * @param {string} key - Document $ID
       * @param {Object|null} oldDoc - Parsed pre-delete body, or null
       */
      const applyGraphDelete = (key, oldDoc) => {
        const prefix = key.split('_')[0];
        const entry = graphPrefixMap.get(prefix);
        if (!entry || !oldDoc) return;
        this._deferredGraphOps.push({ op: 'remove', collection: entry.collection, doc: oldDoc });
      };
      /**
       * Route a WAL set record into the matching collection's vector index.
       * @param {string} key - Document $ID
       * @param {string} value - JSS-encoded document body
       */
      const applyVectorWrite = (key, value) => {
        // Extract collection from the $ID prefix; bail if no vector entry.
        const prefix = key.split('_')[0];
        const collection = prefixToCollection.get(prefix);
        const entry = collection ? this._vectorRegistry.get(collection) : undefined;
        if (!collection || !entry) return;
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
        removeFromVectorIndicesForKey(this, prefixToCollection, key);
      };

      const encryptionKey = this.keyManager?.getKey() || null;
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), { encryptionKey });
      await walReader.replay(startLine, {
        onSet: (key, value) => {
          this.hotTier.set(key, value, false);
          applyVectorWrite(key, value);
          applyGraphWrite(key, value);
        },
        onDelete: (key) => {
          // Capture the pre-delete body for graph cleanup BEFORE hotTier
          // drops it — applyGraphDelete needs the from/to endpoint
          // values to identify which adjacency buckets to clean.
          const preEntry = this.hotTier.documents.get(key);
          const preBody = preEntry && !preEntry.cold && preEntry.data
            ? JSS.parse(preEntry.data) : null;
          this.hotTier.delete(key);
          this.coldTier.deleteDoc(key).catch(() => {});
          const segs = key.split('_');
          if (segs.length >= 2) {
            const shortType = segs[0];
            const member = segs[segs.length - 1];
            this.hotTier.sRem(`${shortType}?`, member);
          }
          applyVectorDelete(key);
          applyGraphDelete(key, preBody);
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
      // Root documents need $ID→toString like runtime get(); nested refs use the
      // shared attachToString walk (same helper as operations-get) so snapshots
      // behave consistently after JSS round-trip.
      for (const doc of Object.values(documents)) {
        if (doc && typeof doc === 'object' && doc.$ID) {
          const $ID = doc.$ID;
          Object.setPrototypeOf(doc, {
            toString: () => $ID,
            toObject: () => doc
          });
          void doc.toString();
          void doc.toObject();
        }
        attachToString(doc);
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
      // Persistent GraphIndex (UC-G7): serialize the bound GraphIndex when
      // it exists and has any registered edge collection. Non-empty graph
      // state forces v4; readers that don't know v4 ignore the unknown
      // field but still consume the v3 payload (forward-compat).
      let graphState = null;
      if (this._graphIndex) {
        const ser = this._graphIndex.serialize();
        if (ser && ser.specs && Object.keys(ser.specs).length > 0) graphState = ser;
      }
      const hasV3Payload = hasVectorState || !!secondaryState;
      const hasV4Payload = !!graphState;
      const base = {
        version: hasV4Payload ? 4 : (hasV3Payload ? 3 : 2),
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
      if (secondaryState) base.secondaryIndexes = secondaryState;
      if (graphState) base.graphIndices = graphState;
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
