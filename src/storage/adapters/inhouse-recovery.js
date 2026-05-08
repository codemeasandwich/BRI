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
 *   v4 - adds graphIndices so edge adjacency survives restart without a
 *        declare-time scan of every edge document.
 *   v5 - adds collectionIdentities so durable collection prefixes are
 *        validated before writes or group reads can mix logical collections.
 *
 * Backwards compatibility:
 *   v1/v2/v3/v4 snapshots load as before. The first snapshot written after
 *   any collection identity is known is v5 (no separate migration step).
 *   Older snapshots do not carry identity catalogs, so the first declared or
 *   written collection claims its derived prefix and persists that mapping
 *   before user data is written.
 */

import path from 'path';
import { WALReader } from '../wal/reader.js';
import JSS from '../../utils/jss/index.js';
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
        } else if (snapshot.version === 5) {
          // v5: v4 payload plus a durable collection identity catalog. The
          // catalog is loaded before WAL replay, then replay-scanned again below
          // so WAL-only identity registrations after the snapshot are included.
          this.loadSnapshotV2(snapshot.documents || {}, snapshot.collections || {});
          this.loadVectorState(snapshot.vectorIndices || {}, snapshot.vectorSchemas || {});
          this.setPendingSecondaryState(snapshot.secondaryIndexes || null);
          this.setPendingGraphState(snapshot.graphIndices || null);
          this.loadCollectionIdentityState(snapshot.collectionIdentities || {});
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
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), {
        encryptionKey,
        logger: this.logger
      });
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
      this.loadCollectionIdentityDocumentsFromHot();
      this.logger.info({
        event: 'storage.inhouse.recovered',
        message: 'InHouse Store: Recovered'
      });
    }
  };
}
