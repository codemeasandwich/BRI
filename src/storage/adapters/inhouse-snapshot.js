/**
 * @file Snapshot load/write helpers for the in-house storage adapter.
 *
 * Domain context: snapshots are Bri's fast boot path and carry durable state
 * for documents, collection membership, vector indexes, secondary indexes,
 * graph adjacency, and collection identities.
 *
 * Technical context: this mixin owns snapshot payload serialization and
 * version-aware load helpers; recovery remains focused on boot orchestration and
 * WAL replay.
 */

import path from 'path';
import { WALReader } from '../wal/reader.js';
import JSS from '../../utils/jss/index.js';
import { VectorIndex } from '../../engine/vector-index.js';
import { attachToString } from '../../engine/helpers.js';
import {
  chooseSnapshotVersion,
  collectionIdentitySnapshotState
} from './inhouse-snapshot-version.js';

/**
 * Create snapshot methods mixed into `InHouseAdapter`.
 *
 * @returns {Object} Snapshot load/write methods.
 */
export function createSnapshotMethods() {
  return {
    /**
     * Load serialized VectorIndex state from a snapshot into the store cache.
     *
     * @param {Object} serializedIndices - Base64 index buffers by collection.
     * @param {Object} schemas - Vector schemas by collection.
     * @returns {void}
     */
    loadVectorState(serializedIndices, schemas) {
      for (const [collection, schema] of Object.entries(schemas)) {
        const b64 = serializedIndices[collection];
        if (!b64) {
          const empty = new VectorIndex({
            dims: schema.dims, metric: schema.metric || 'cosine'
          });
          this._vectorRegistry.set(collection, { schema, index: empty });
          continue;
        }
        const buf = Buffer.from(b64, 'base64');
        const index = VectorIndex.deserialize(buf, { logger: this.logger });
        this._vectorRegistry.set(collection, { schema, index });
      }
      const count = Object.keys(schemas).length;
      if (count > 0) {
        this.logger.info({
          event: 'storage.inhouse.vector_state.loaded',
          message: `InHouse Store: Loaded vector state for ${count} collection(s)`,
          metadata: { count }
        });
      }
    },

    /**
     * Load a v2+ snapshot's document and collection payloads into hot tier.
     *
     * @param {Object} documents - Snapshot document map.
     * @param {Object} collections - Snapshot collection membership map.
     * @returns {void}
     */
    loadSnapshotV2(documents, collections) {
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
      const count = Object.keys(documents).length;
      this.logger.info({
        event: 'storage.inhouse.snapshot_v2.loaded',
        message: `InHouse Store: Loaded v2 snapshot with ${count} documents`,
        metadata: { count }
      });
    },

    /**
     * Build the current durable snapshot payload for SnapshotManager.
     *
     * @returns {Promise<Object>} Versioned snapshot state.
     */
    async getSnapshotState() {
      const encryptionKey = this.keyManager?.getKey() || null;
      const walReader = new WALReader(path.join(this.config.dataDir, 'wal'), {
        encryptionKey,
        logger: this.logger
      });
      const walLine = await walReader.getLineCount();
      const hasVectorState = this._vectorRegistry.size > 0;
      let secondaryState = null;
      if (this._secondaryIndexManager) {
        const ser = this._secondaryIndexManager.serialize();
        if (ser && Object.keys(ser).length > 0) secondaryState = ser;
      }
      let graphState = null;
      if (this._graphIndex) {
        const ser = this._graphIndex.serialize();
        if (ser && ser.specs && Object.keys(ser.specs).length > 0) graphState = ser;
      }
      const hasV3Payload = hasVectorState || !!secondaryState;
      const hasV4Payload = !!graphState;
      const {
        state: collectionIdentities,
        hasIdentityState
      } = collectionIdentitySnapshotState(this._collectionIdentities);
      const base = {
        version: chooseSnapshotVersion({ hasIdentityState, hasV4Payload, hasV3Payload }),
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
      if (hasIdentityState) base.collectionIdentities = collectionIdentities;
      return base;
    },

    /**
     * Write a snapshot and archive consumed WAL segments when successful.
     *
     * @returns {Promise<string|null>} Snapshot path when one was written.
     */
    async createSnapshot() {
      const state = await this.getSnapshotState();
      const snapshotPath = await this.snapshots.create(state);
      if (snapshotPath) await this.wal.archive();
      return snapshotPath;
    }
  };
}
