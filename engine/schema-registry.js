/**
 * @file Per-database schema registry
 *
 * Holds collection schemas declared via db.schema('name', def). The registry
 * is the single source of truth that downstream features consult:
 *
 *   - VectorIndex instances are created here (one per vector field)
 *   - Validation middleware reads schemas from here on add/set
 *   - Future: secondary indexes, edge declarations, cascade scopes all
 *     register through this surface
 *
 * Why a registry (instead of attaching schema directly to the store):
 *   - Keeps the storage layer schema-agnostic; storage cares about bytes
 *     and IDs, not field semantics.
 *   - Allows schemas to be declared lazily after createDB resolves, matching
 *     existing Bri ergonomics where users wire middleware after construction.
 *   - One central object lets us derive cross-cutting state (which collections
 *     have vectors? which fields are refs?) without re-scanning every schema.
 *
 * Backwards compatibility:
 *   Collections without a registered schema work exactly as before — no
 *   validation, no vector index. Schema registration is opt-in.
 */

import validate from '../utils/schema/index.js';
import { VectorIndex } from './vector-index.js';
import SecondaryIndexManager from './secondary-index.js';

/**
 * Create a schema registry instance.
 *
 * @param {Object} [store] - Storage adapter; when provided, the registry
 *   consults its persisted vector-index cache on declare() so that a process
 *   restart restores the index from snapshot. When omitted, behaves as before
 *   (fresh index per declare). The store is also notified of new schemas so
 *   future snapshots persist them.
 * @returns {Object} Registry with declare/get/vectorIndex/validate/vectorFieldOf
 */
export function createSchemaRegistry(store) {
  // collection name → schema definition POJO
  const schemas = new Map();
  // collection name → VectorIndex instance (only for collections with a vector field)
  const vectorIndices = new Map();
  // collection name → vector field name (cached for fast middleware lookup)
  const vectorFields = new Map();
  // Per-database secondary-index manager. Populated lazily when a schema
  // declares $indexes; the registry hands out a single shared instance so
  // middleware and the query planner observe consistent state.
  const secondaryIndexes = new SecondaryIndexManager();
  // Restore persisted secondary indexes from the store before any declare()
  // runs — keeps the spec-validation path consistent with vector indices.
  if (store && typeof store.getSecondaryIndexState === 'function') {
    const persisted = store.getSecondaryIndexState();
    if (persisted) secondaryIndexes.load(persisted);
  }
  // Bind the manager back to the store so the next snapshot serializes it.
  // The store keeps a reference; on disconnect / scheduled snapshot,
  // getSnapshotState calls manager.serialize() on this same instance.
  if (store && typeof store.bindSecondaryIndexManager === 'function') {
    store.bindSecondaryIndexManager(secondaryIndexes);
  }

  /**
   * Walk a schema definition and pick out the vector field, if any.
   * v1 supports at most ONE vector field per collection. Multiple vector
   * fields are not part of any UC and would require disambiguating which
   * field .near() targets.
   *
   * @param {Object} schemaDef
   * @returns {{name:string, dims:number, metric:string}|null}
   */
  function findVectorField(schemaDef) {
    let found = null;
    for (const [name, decl] of Object.entries(schemaDef)) {
      if (decl && decl.type === 'vector') {
        if (found) {
          throw new Error(
            `Schema declares more than one vector field ` +
            `('${found.name}' and '${name}'). v1 supports at most one.`
          );
        }
        found = { name, dims: decl.dims, metric: decl.metric || 'cosine' };
      }
    }
    return found;
  }

  return {
    /**
     * Register a schema for a collection.
     *
     * Side effects when the schema declares a vector field:
     *   1. If the store has a persisted entry for this collection (loaded from
     *      a snapshot during recovery), we reuse its index and validate that
     *      the new declaration matches the persisted dims/metric/field.
     *      Drift is rejected with a diagnostic error so the user can either
     *      revert the schema change or rebuild the index explicitly.
     *   2. Otherwise we create a fresh VectorIndex and (when a store is
     *      attached) register it with the store so future snapshots persist
     *      it and WAL replays can update it.
     *
     * @param {string} collection - Collection name (matches db.add.{collection})
     * @param {Object} schemaDef  - Field definitions; see utils/schema
     * @returns {void}
     * @throws {Error} on multiple vector fields or drift against persisted index
     */
    declare(collection, schemaDef) {
      schemas.set(collection, schemaDef);

      // Process $indexes first — declaration order is independent of vector
      // wiring, but a malformed $indexes spec must throw BEFORE we touch the
      // vector index. Each entry is an array of field names; every field
      // referenced must be declared on the collection.
      const indexSpecs = Array.isArray(schemaDef.$indexes) ? schemaDef.$indexes : null;
      if (indexSpecs) {
        for (const spec of indexSpecs) {
          if (!Array.isArray(spec) || spec.length === 0) {
            throw new Error(
              `Schema '${collection}' has malformed $indexes entry — ` +
              `expected an array of field names, got ${JSON.stringify(spec)}.`
            );
          }
          for (const field of spec) {
            if (!Object.prototype.hasOwnProperty.call(schemaDef, field)) {
              throw new Error(
                `Schema '${collection}' declares index on field '${field}' ` +
                `which is not declared on the collection. Available fields: ` +
                `${Object.keys(schemaDef).filter(k => !k.startsWith('$')).join(', ')}.`
              );
            }
          }
          secondaryIndexes.declare(collection, spec);
        }
      }

      const vec = findVectorField(schemaDef);
      if (!vec) return;
      vectorFields.set(collection, vec.name);

      const persisted = store && typeof store.getVectorEntry === 'function'
        ? store.getVectorEntry(collection)
        : undefined;

      if (persisted) {
        // Drift detection. Renaming the field is a structural change we
        // cannot transparently reconcile because the persisted index is
        // keyed off the old field; refuse and require explicit action.
        const ps = persisted.schema;
        if (ps.dims !== vec.dims || (ps.metric || 'cosine') !== vec.metric) {
          throw new Error(
            `Vector index drift on '${collection}': persisted index has ` +
            `dims=${ps.dims}/metric=${ps.metric || 'cosine'}, ` +
            `but new schema declares dims=${vec.dims}/metric=${vec.metric}. ` +
            `Revert the schema change or delete the data directory to rebuild.`
          );
        }
        if (ps.field !== vec.name) {
          throw new Error(
            `Vector field rename on '${collection}': persisted index targets ` +
            `field '${ps.field}', but new schema declares field '${vec.name}'. ` +
            `Rename in the schema is not auto-migrated; either keep the old ` +
            `field name or delete the data directory to rebuild.`
          );
        }
        vectorIndices.set(collection, persisted.index);
      } else {
        const fresh = new VectorIndex({ dims: vec.dims, metric: vec.metric });
        vectorIndices.set(collection, fresh);
        if (store && typeof store.registerVectorIndex === 'function') {
          store.registerVectorIndex(
            collection,
            { field: vec.name, dims: vec.dims, metric: vec.metric },
            fresh
          );
        }
      }
    },

    /**
     * Look up the schema for a collection.
     * @param {string} collection
     * @returns {Object|undefined}
     */
    get(collection) {
      return schemas.get(collection);
    },

    /**
     * Look up the VectorIndex for a collection, or undefined if the
     * collection has no vector field declared.
     * @param {string} collection
     * @returns {VectorIndex|undefined}
     */
    vectorIndex(collection) {
      return vectorIndices.get(collection);
    },

    /**
     * Look up the name of the vector field on a collection (e.g. 'embedding').
     * Returned name is what the indexing middleware reads from each document.
     * @param {string} collection
     * @returns {string|undefined}
     */
    vectorFieldOf(collection) {
      return vectorFields.get(collection);
    },

    /**
     * Validate a document against its registered schema. No-op (returns null)
     * if no schema is registered — preserves the opt-in convention.
     *
     * @param {string} collection
     * @param {Object} doc
     * @returns {string|null} Error message or null if valid / no schema
     */
    validate(collection, doc) {
      const schema = schemas.get(collection);
      if (!schema) return null;
      return validate(schema, doc);
    },

    /**
     * Access the SecondaryIndexManager instance shared across the database.
     * Used by the query planner and the index-sync middleware.
     * @returns {SecondaryIndexManager}
     */
    secondaryIndexManager() {
      return secondaryIndexes;
    }
  };
}

export default createSchemaRegistry;
