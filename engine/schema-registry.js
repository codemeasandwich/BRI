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

/**
 * Create a schema registry instance.
 *
 * @returns {Object} Registry with declare/get/vectorIndex/validate/vectorFieldOf
 */
export function createSchemaRegistry() {
  // collection name → schema definition POJO
  const schemas = new Map();
  // collection name → VectorIndex instance (only for collections with a vector field)
  const vectorIndices = new Map();
  // collection name → vector field name (cached for fast middleware lookup)
  const vectorFields = new Map();

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
     * Side effects: if the schema declares a vector field, a VectorIndex is
     * created for that collection and stored under the same key. The index is
     * empty initially; the auto-indexing middleware populates it on add/set
     * and clears entries on del.
     *
     * @param {string} collection - Collection name (matches db.add.{collection})
     * @param {Object} schemaDef  - Field definitions; see utils/schema
     * @returns {void}
     * @throws {Error} on multiple vector fields
     */
    declare(collection, schemaDef) {
      schemas.set(collection, schemaDef);
      const vec = findVectorField(schemaDef);
      if (vec) {
        vectorFields.set(collection, vec.name);
        vectorIndices.set(collection, new VectorIndex({
          dims: vec.dims, metric: vec.metric
        }));
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
    }
  };
}

export default createSchemaRegistry;
