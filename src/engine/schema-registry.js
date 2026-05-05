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
import { GraphIndex } from './graph-index.js';
import { type2Short } from './types.js';
import {
  buildEdgeSpec,
  registerPredicateRouting,
  registerInversePredicateRouting,
  collectLifecycleFields,
  collectCascadeEntries
} from './schema-edge-declare.js';
import { canonicalPairKeyFor } from './canonical-pair.js';

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
  /*
   * Per-database state Maps:
   *   schemas              collection name → schema definition POJO
   *   vectorIndices        collection name → VectorIndex (vector-bearing collections only)
   *   vectorFields         collection name → vector field name (fast middleware lookup)
   *   graphIndex           shared adjacency index, populated as $edge schemas declare
   *   collectionByPrefix   $ID-prefix → collection (predicate-proxy uses this to
   *                        resolve an entity's collection from its $ID at access time)
   *   edgeCollections      collection → enriched edge spec (kept here so cross-schema
   *                        collisions can be detected without round-tripping through
   *                        the index layer)
   *   predicatesBySubject  subject-collection → Map<predicate, edgeCollection>
   *                        (forward routing for alice.works_at → kgTriple)
   *   predicatesByObject   mirror of above for inverse routing (acme.inverse.works_at)
   *   cascadeByScope       scope name → [{collection, field}, ...] for db.cascade.{scope}
   *                        (empty when schema did not opt in via cascadeOn)
   *   lifecycleFields      collection → {supersession?, confidence?, provenance?},
   *                        drives default-supersession filter and chain-method
   *                        availability (§2.2: chain methods exist iff the matching
   *                        $-flag is declared)
   */
  const schemas = new Map();
  const vectorIndices = new Map();
  const vectorFields = new Map();
  const graphIndex = new GraphIndex();
  const collectionByPrefix = new Map();
  const edgeCollections = new Map();
  const predicatesBySubject = new Map();
  const predicatesByObject = new Map();
  const cascadeByScope = new Map();
  const lifecycleFields = new Map();
  /* UC-G3 — collections whose schema declared `$edge.unique &&
   * $edge.symmetric` (validated together in schema-edge-declare.js).
   * Membership here drives the synthetic `__edgePair` secondary index,
   * vector-middleware's pre-write uniqueness check, and QueryBuilder's
   * `.between(a, b)` eligibility check. Centralized in the registry
   * rather than re-derived from `enrichedSpec.unique && .symmetric` at
   * every call site so all consumers observe the same truth. */
  const canonicalPairCollections = new Set();

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

      // Build the prefix → collection lookup for this collection so the
      // predicate proxy can resolve an entity's collection from its $ID.
      // Done lazily here (not at first read) so reading happens off the
      // hot path.
      const prefix = type2Short(collection);
      collectionByPrefix.set(prefix, collection);

      // Process $edge first — collisions and reserved-name checks must
      // throw before any other state mutation. $edge declares the
      // collection as an edge collection; predicate names are validated
      // against the reserved list and against subject-collection
      // ambiguities.
      const edge = schemaDef.$edge;
      if (edge) {
        // Resolve concrete field names + reserved-name check, then register
        // routing. See engine/schema-edge-declare.js for the rules.
        const { enrichedSpec, predicates } = buildEdgeSpec(collection, schemaDef);
        edgeCollections.set(collection, enrichedSpec);
        graphIndex.declareEdge(collection, enrichedSpec);
        registerPredicateRouting(predicatesBySubject, edge, collection, predicates);
        registerInversePredicateRouting(predicatesByObject, edge, collection, predicates);

        /* UC-G3 — when the edge declared both `unique` and `symmetric`,
         * back the uniqueness invariant with a SortedIndex on the
         * synthetic `__edgePair` field. The synthetic value is `[min,
         * max]` of the endpoint $IDs, projected onto a shadow doc by
         * vector-middleware (the body itself is never mutated). The same
         * SecondaryIndexManager that backs declared `$indexes` carries
         * this index — it already serializes inside the snapshot,
         * already integrates with the add/set/del middleware flow, and
         * already supports the canonical-pair key shape via
         * compoundKey(JSON.stringify). A parallel structure would
         * duplicate three subsystems for no gain. */
        if (enrichedSpec.unique && enrichedSpec.symmetric) {
          secondaryIndexes.declare(collection, ['__edgePair']);
          canonicalPairCollections.add(collection);
        }
      }

      // cascadeOn flagged fields: helper validates + emits; we just file.
      for (const { scope, ...entry } of collectCascadeEntries(collection, schemaDef)) {
        if (!cascadeByScope.has(scope)) cascadeByScope.set(scope, []);
        cascadeByScope.get(scope).push(entry);
      }

      // Capture lifecycle-field flags ($supersession / $confidence /
      // $provenance). Validation lives in collectLifecycleFields so a
      // typo in the schema fails at db.schema time, not silently at read.
      const lifecycle = collectLifecycleFields(collection, schemaDef);
      if (lifecycle) lifecycleFields.set(collection, lifecycle);

      // Process $indexes — a malformed $indexes spec must throw BEFORE we
      // touch the vector index. Each entry is an array of field names;
      // every field referenced must be declared on the collection.
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
     * @returns {void}
     * @throws {BriValidationError} on schema-validation failure (typed-error
     *         migration: validator now throws — see utils/schema/index.js
     *         file docblock for the full migration note)
     */
    validate(collection, doc) {
      const schema = schemas.get(collection);
      if (!schema) return;
      validate(schema, doc);
    },

    /**
     * Access the SecondaryIndexManager instance shared across the database.
     * Used by the query planner and the index-sync middleware.
     * @returns {SecondaryIndexManager}
     */
    secondaryIndexManager() {
      return secondaryIndexes;
    },

    /**
     * Iterate all registered vector indices. Used by transaction lifecycle
     * hooks (fin/nop/pop in client/proxy.js) to flush, drop, or pop staged
     * vector ops across every collection that has a vector field.
     * @returns {Iterable<[string, Object]>} yields [collection, VectorIndex]
     */
    vectorIndices() {
      return vectorIndices.entries();
    },

    /**
     * Access the shared GraphIndex instance.
     * @returns {GraphIndex}
     */
    graphIndex() {
      return graphIndex;
    },

    /**
     * Look up the edge spec for a collection, or undefined if not an edge.
     * @param {string} collection
     * @returns {Object|undefined}
     */
    edgeSpec(collection) {
      return edgeCollections.get(collection);
    },

    /**
     * Resolve the collection name for an entity given its $ID prefix.
     * Used by the predicate proxy at property-access time.
     * @param {string} prefix - Four-letter $ID prefix (uppercase)
     * @returns {string|undefined}
     */
    collectionForPrefix(prefix) {
      return collectionByPrefix.get(prefix);
    },

    /**
     * Look up the edge collection for (subjectCollection, predicate). Used
     * by the predicate proxy: alice.works_at → predicateEdge('kgEntity', 'works_at')
     * returns 'kgTriple'.
     * @param {string} subjectCollection
     * @param {string} predicate
     * @returns {string|undefined}
     */
    predicateEdge(subjectCollection, predicate) {
      const map = predicatesBySubject.get(subjectCollection);
      return map ? map.get(predicate) : undefined;
    },

    /**
     * Look up the edge collection for inverse reads — given the OBJECT
     * collection (the to-side of the edge) and a predicate, return the
     * matching edge collection. Used by `acme.inverse.works_at`.
     * @param {string} objectCollection
     * @param {string} predicate
     * @returns {string|undefined}
     */
    inversePredicateEdge(objectCollection, predicate) {
      const map = predicatesByObject.get(objectCollection);
      return map ? map.get(predicate) : undefined;
    },

    /**
     * Iterate every (predicate, edgeCollection) registered for a given
     * subject collection. Used by `entity.related` to enumerate all
     * outgoing edges across the predicate vocabulary.
     * @param {string} subjectCollection
     * @returns {Iterable<[string, string]>} [predicate, edgeCollection]
     */
    predicatesForSubject(subjectCollection) {
      const map = predicatesBySubject.get(subjectCollection);
      return map ? map.entries() : [];
    },

    /**
     * Look up cascade entries for a given scope name. Each entry is
     * { collection, field } — the cascade routine iterates these to find
     * docs matching the scope id.
     *
     * @param {string} scope - Scope name (e.g. 'session')
     * @returns {Array<{collection:string, field:string}>}
     */
    cascadeEntriesFor(scope) {
      return cascadeByScope.get(scope) || [];
    },

    /**
     * Look up lifecycle-field names for a collection. Returns an object
     * with optional `supersession`, `confidence`, `provenance` keys mapping
     * to the declared field names; undefined when no $-flag is set.
     *
     * Drives default supersession filtering on predicate reads and the
     * conditional availability of .history / .confidence(t) / .withProvenance
     * chain methods on the PredicateAccessor.
     *
     * @param {string} collection
     * @returns {Object|undefined} {supersession?, confidence?, provenance?}
     */
    lifecycleFieldsOf(collection) {
      return lifecycleFields.get(collection);
    },

    /**
     * UC-G3 — true iff `collection` is an edge collection whose schema
     * declared both `$edge.unique` and `$edge.symmetric`. Read by:
     *   - vector-middleware (whether to project `__edgePair` into the
     *     shadow doc and whether to run the pre-write uniqueness check),
     *   - QueryBuilder (whether `.between(a, b)` is legal on this
     *     collection — throws otherwise so misuse fails loudly).
     *
     * @param {string} collection
     * @returns {boolean}
     */
    needsCanonicalPair(collection) {
      return canonicalPairCollections.has(collection);
    },

    /**
     * UC-G3 — compute the canonical-pair key for an edge document via
     * the engine/canonical-pair.js helper. Returns `[min, max]` of the
     * two endpoint $IDs or null when an endpoint is missing.
     *
     * @param {string} collection - Edge collection name
     * @param {Object} doc - Edge document (must carry the from/to fields)
     * @returns {Array<string>|null}
     */
    canonicalPairKey(collection, doc) {
      return canonicalPairKeyFor(edgeCollections.get(collection), doc);
    }
  };
}

export default createSchemaRegistry;
