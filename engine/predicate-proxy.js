/**
 * @file Predicate-aware proxy for reactive entities.
 *
 * Implements §2.3 / §2.4 / §3.5 of the spec — when a reactive entity
 * (`alice`) is accessed by a property name that's a registered predicate
 * (`alice.works_at`), the lookup returns a PredicateAccessor with
 * thenable-read / callable-write / `.limit(n)` / `.$` (edge docs) /
 * inverse-read (`acme.inverse.works_at`) / multi-predicate-read (`alice.related`)
 * semantics.
 *
 * Property-access lookup (§3.5), fall-through order:
 *   1. Built-ins (toJSON/toJSS/save/etc.) — handled upstream by reactive proxy
 *   2. `and` — handled upstream (back-compat single-hop ref population)
 *   3. `inverse` — return InverseProxy whose .{predicate} reads incoming
 *   4. `related` — return RelatedAccessor over all outgoing predicates
 *   5. Declared field — return raw value (reactive proxy fall-through)
 *   6. Registered predicate (subject side) — return PredicateAccessor
 *   7. Otherwise — return undefined; reactive proxy continues
 *
 * @implements UC-G1 (one-hop read + write + .limit + .$ + inverse + related)
 */

import { type2Short } from '../engine/types.js';

/**
 * Decide whether a property access on an entity should be resolved by the
 * predicate-proxy layer. Returns the PredicateAccessor when yes; undefined
 * when no — the reactive proxy continues with its existing fallthrough.
 *
 * @param {Object} target - Underlying entity body (POJO with $ID and fields)
 * @param {string} name - Property name accessed
 * @param {Object} registry - Schema registry (predicateEdge, edgeSpec, etc.)
 * @param {Object} wrapper - Engine wrapper (for hydration + writes)
 * @returns {Function|undefined} PredicateAccessor or undefined
 */
export function resolvePredicateAccess(target, name, registry, wrapper) {
  if (!target || !target.$ID) return undefined;
  // 'and' is the existing single-hop ref proxy — let the reactive layer
  // keep handling it.
  if (name === 'and') return undefined;

  // Resolve the entity's own collection from its $ID prefix; many of the
  // routes below depend on it.
  const prefix = target.$ID.split('_')[0];
  const subjectCollection = registry.collectionForPrefix(prefix);

  // 'inverse' returns a Proxy whose .{predicate} access reads the inverse
  // adjacency. Available even when the entity is not on a from-side, as
  // long as the registry has an inverse mapping for (collection, predicate).
  if (name === 'inverse') {
    if (!subjectCollection) return undefined;
    return makeInverseProxy({ target, registry, wrapper, objectCollection: subjectCollection });
  }

  // 'related' returns a thenable that flattens outgoing edges across every
  // predicate registered for the subject collection.
  if (name === 'related') {
    if (!subjectCollection) return undefined;
    return makeRelatedAccessor({ target, registry, wrapper, subjectCollection });
  }

  // Declared fields on the entity are not predicates.
  if (name in target) return undefined;
  if (!subjectCollection) return undefined;
  // Find the matching edge collection (if any) for this predicate name.
  const edgeCollection = registry.predicateEdge(subjectCollection, name);
  if (!edgeCollection) return undefined;
  // Resolved — return a PredicateAccessor bound to this entity + edge.
  return makePredicateAccessor({
    subjectId: target.$ID,
    subjectCollection,
    edgeCollection,
    predicate: name,
    edgeSpec: registry.edgeSpec(edgeCollection),
    graphIndex: registry.graphIndex(),
    wrapper,
    // Lazy db accessor — required so predicate-proxy writes route through
    // middleware (validation + vector + graph index sync). Without this
    // the writes would hit the raw engine and skip the middleware chain.
    getDb: wrapper._getDb
  });
}

/**
 * Build a PredicateAccessor: a thenable function that writes edges when
 * called, reads targets when awaited, and supports `.limit(n)` for read
 * truncation.
 *
 * @param {Object} ctx - Bound state (subjectId, edgeCollection, etc.)
 * @returns {Function} accessor
 */
function makePredicateAccessor(ctx) {
  // The shape: a callable function. Function invocation does writes;
  // attaching .then makes it thenable for reads; .limit returns a
  // bounded variant; .$ exposes the underlying edge documents.
  const accessor = async function predicateWrite(target, attrs = {}) {
    return writeEdge(ctx, target, attrs);
  };
  accessor.then = (onResolve, onReject) =>
    readTargets(ctx, undefined).then(onResolve, onReject);
  accessor.limit = function limit(k) {
    return {
      then: (onResolve, onReject) =>
        readTargets(ctx, k).then(onResolve, onReject)
    };
  };
  // .$ — thenable that resolves to the edge documents themselves rather
  // than the hydrated targets. Useful for reading edge attributes
  // (confidence, provenance, etc.) without a separate edge fetch.
  accessor.$ = {
    then: (onResolve, onReject) =>
      readEdges(ctx, undefined).then(onResolve, onReject)
  };
  return accessor;
}

/**
 * Write a new edge document. The edge's from/predicate/to fields come from
 * the registered $edge spec; any extra attrs from the caller are merged.
 *
 * @param {Object} ctx
 * @param {Object|string} target - Target entity (or string $ID for refs)
 * @param {Object} attrs - Extra fields on the edge document
 * @returns {Promise<Object>} new edge entity
 */
async function writeEdge(ctx, target, attrs) {
  const { subjectId, edgeCollection, predicate, edgeSpec, getDb } = ctx;
  const targetId = typeof target === 'string' ? target : (target && target.$ID);
  if (!targetId) {
    throw new Error(
      `Predicate '${predicate}': target must be an entity (with $ID) or a string $ID; ` +
      `got ${typeof target}`
    );
  }
  const doc = {
    [edgeSpec.from]: subjectId,
    [edgeSpec.to]: targetId,
    ...(edgeSpec.predicate ? { [edgeSpec.predicate]: predicate } : {}),
    ...attrs
  };
  // Route through db.add.{collection} so the middleware chain (validation
  // + vector + graph index sync) runs identically to a direct user call.
  // Without this the graph adjacency would never be populated and reads
  // would see no targets.
  const db = getDb && getDb();
  if (!db || !db.add || !db.add[edgeCollection]) {
    throw new Error(
      `Predicate proxy could not access db.add.${edgeCollection} for edge write`
    );
  }
  return db.add[edgeCollection](doc);
}

/**
 * Read outgoing edges + hydrate target entities. The graph-index lookup
 * gives us edge $IDs in O(degree); a single pass hydrates each edge to
 * read its `to` field, and another hydrates the target entities.
 *
 * @param {Object} ctx
 * @param {number|undefined} k - Optional top-k cap
 * @returns {Promise<Array<Object>>} target entities
 */
async function readTargets(ctx, k) {
  const edges = await readEdges(ctx, k);
  return hydrateEndpoints(edges, ctx.edgeSpec.to, ctx.wrapper);
}

/**
 * Read outgoing edge documents for a subject + predicate. Used by both the
 * `await alice.works_at` path (to learn the `to` field) and the public
 * `alice.works_at.$` path (which exposes the edges directly so callers can
 * inspect attributes).
 *
 * @param {Object} ctx - Bound state including subjectId, edgeCollection, predicate
 * @param {number|undefined} k - Optional top-k cap
 * @returns {Promise<Array<Object>>} edge documents
 */
async function readEdges(ctx, k) {
  const { subjectId, edgeCollection, predicate, graphIndex, wrapper } = ctx;
  const edgeIds = graphIndex.outgoing(subjectId, edgeCollection, predicate);
  const capped = typeof k === 'number' ? edgeIds.slice(0, k) : edgeIds;
  const edges = await Promise.all(
    capped.map(id => wrapper.get(edgeCollection, id))
  );
  return edges.filter(Boolean);
}

/**
 * Read incoming edge documents for an object + predicate. Used by the
 * inverse proxy (`acme.inverse.works_at`) and `acme.inverse.works_at.$`.
 *
 * @param {Object} ctx - Bound state including objectId, edgeCollection, predicate
 * @param {number|undefined} k
 * @returns {Promise<Array<Object>>} edge documents
 */
async function readInverseEdges(ctx, k) {
  const { objectId, edgeCollection, predicate, graphIndex, wrapper } = ctx;
  const edgeIds = graphIndex.incoming(objectId, edgeCollection, predicate);
  const capped = typeof k === 'number' ? edgeIds.slice(0, k) : edgeIds;
  const edges = await Promise.all(
    capped.map(id => wrapper.get(edgeCollection, id))
  );
  return edges.filter(Boolean);
}

/**
 * Hydrate edge endpoints into target entities. For polymorphic ref|string
 * targets the field value may be a literal string — those pass through
 * unchanged since v1's predicate proxy is entity-target-oriented.
 *
 * @param {Array<Object>} edges
 * @param {string} fieldName - Either the from-field or to-field
 * @param {Object} wrapper
 * @returns {Promise<Array<Object>>}
 */
async function hydrateEndpoints(edges, fieldName, wrapper) {
  const targets = await Promise.all(
    edges.map(edge => {
      const targetId = edge && edge[fieldName];
      if (!targetId) return null;
      // wrapper.get(null, $ID) is the type-agnostic single fetch — uses
      // the $ID prefix to pick the collection internally.
      return wrapper.get(null, targetId);
    })
  );
  return targets.filter(Boolean);
}

/**
 * Build the InverseProxy returned for `entity.inverse`. Property accesses
 * on the inverse proxy are predicate names; each one reads the inverse
 * adjacency for the entity and hydrates the from-side (subjects).
 *
 * @param {Object} args
 * @param {Object} args.target - The reactive entity body
 * @param {Object} args.registry
 * @param {Object} args.wrapper
 * @param {string} args.objectCollection - Entity's collection (this is the to-side)
 * @returns {Proxy}
 */
function makeInverseProxy({ target, registry, wrapper, objectCollection }) {
  return new Proxy({}, {
    /**
     * @param {Object} _t
     * @param {string|symbol} predicate
     * @returns {Object|undefined}
     */
    get(_t, predicate) {
      if (typeof predicate === 'symbol') return undefined;
      const edgeCollection = registry.inversePredicateEdge(objectCollection, predicate);
      if (!edgeCollection) return undefined;
      const ctx = {
        objectId: target.$ID,
        edgeCollection,
        predicate,
        edgeSpec: registry.edgeSpec(edgeCollection),
        graphIndex: registry.graphIndex(),
        wrapper
      };
      const accessor = {
        then: (onResolve, onReject) =>
          readInverseEdges(ctx, undefined)
            .then(edges => hydrateEndpoints(edges, ctx.edgeSpec.from, wrapper))
            .then(onResolve, onReject)
      };
      // .$ exposes the edge docs themselves on the inverse path too.
      accessor.$ = {
        then: (onResolve, onReject) =>
          readInverseEdges(ctx, undefined).then(onResolve, onReject)
      };
      return accessor;
    }
  });
}

/**
 * Build the RelatedAccessor returned for `entity.related`. Awaiting it
 * resolves to a flat list of every outgoing target across every registered
 * predicate; `.$` exposes the underlying edge docs.
 *
 * @param {Object} args
 * @param {Object} args.target
 * @param {Object} args.registry
 * @param {Object} args.wrapper
 * @param {string} args.subjectCollection
 * @returns {Object} thenable + .$
 */
function makeRelatedAccessor({ target, registry, wrapper, subjectCollection }) {
  const graphIndex = registry.graphIndex();
  /**
   * Collect every outgoing edge doc across all registered predicates.
   * @returns {Promise<Array<Object>>}
   */
  const allEdges = async () => {
    const edges = [];
    for (const [predicate, edgeCollection] of registry.predicatesForSubject(subjectCollection)) {
      const edgeIds = graphIndex.outgoing(target.$ID, edgeCollection, predicate);
      for (const id of edgeIds) {
        const edge = await wrapper.get(edgeCollection, id);
        if (edge) edges.push(edge);
      }
    }
    return edges;
  };
  /**
   * Collect every outgoing target across all registered predicates,
   * grouping edges by edge collection so each collection's to-field can
   * resolve the right endpoint.
   * @returns {Promise<Array<Object>>}
   */
  const allTargets = async () => {
    // Group edges by their edge collection so we know which to-field to use
    // when hydrating endpoints. v1 schemas typically have one edge collection
    // per subject, but the loop is collection-agnostic.
    const collectionEdges = new Map();
    for (const [predicate, edgeCollection] of registry.predicatesForSubject(subjectCollection)) {
      const edgeIds = graphIndex.outgoing(target.$ID, edgeCollection, predicate);
      if (edgeIds.length === 0) continue;
      if (!collectionEdges.has(edgeCollection)) collectionEdges.set(edgeCollection, []);
      const acc = collectionEdges.get(edgeCollection);
      for (const id of edgeIds) {
        const edge = await wrapper.get(edgeCollection, id);
        if (edge) acc.push(edge);
      }
    }
    const out = [];
    for (const [edgeCollection, edges] of collectionEdges) {
      const spec = registry.edgeSpec(edgeCollection);
      const hydrated = await hydrateEndpoints(edges, spec.to, wrapper);
      out.push(...hydrated);
    }
    return out;
  };
  return {
    /**
     * @param {Function} onResolve
     * @param {Function} onReject
     * @returns {Promise<Array>}
     */
    then: (onResolve, onReject) => allTargets().then(onResolve, onReject),
    $: {
      /**
       * @param {Function} onResolve
       * @param {Function} onReject
       * @returns {Promise<Array>}
       */
      then: (onResolve, onReject) => allEdges().then(onResolve, onReject)
    }
  };
}
