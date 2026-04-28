/**
 * @file Inverse + related accessors for the predicate proxy.
 *
 * `entity.inverse.{predicate}` reads the incoming adjacency for that
 * predicate and hydrates from-side endpoints. `entity.related` flattens
 * outgoing edges across every predicate registered for the subject's
 * collection and unions the targets into one array.
 *
 * Both accessors expose `.$` for the underlying edge documents, mirroring
 * the forward PredicateAccessor's API surface.
 *
 * Extracted from predicate-proxy.js so that file stays under the 260-
 * source-line gate; the resolution algorithm in resolvePredicateAccess
 * routes 'inverse' and 'related' here.
 *
 * @implements UC-G1 (read-side: inverse + related)
 */

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
export function makeInverseProxy({ target, registry, wrapper, objectCollection }) {
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
          readInverseEdges(ctx)
            .then(edges => hydrateEndpoints(edges, ctx.edgeSpec.from, wrapper))
            .then(onResolve, onReject)
      };
      // .$ exposes the edge docs themselves on the inverse path too.
      accessor.$ = {
        then: (onResolve, onReject) =>
          readInverseEdges(ctx).then(onResolve, onReject)
      };
      return accessor;
    }
  });
}

/**
 * Build the RelatedAccessor returned for `entity.related`. Awaiting it
 * resolves to a flat list of every outgoing target across every
 * registered predicate; `.$` exposes the underlying edge docs.
 *
 * @param {Object} args
 * @param {Object} args.target
 * @param {Object} args.registry
 * @param {Object} args.wrapper
 * @param {string} args.subjectCollection
 * @returns {Object} thenable + .$
 */
export function makeRelatedAccessor({ target, registry, wrapper, subjectCollection }) {
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

/**
 * Read incoming edge documents for an object + predicate.
 *
 * @param {Object} ctx - Bound state including objectId, edgeCollection, predicate
 * @returns {Promise<Array<Object>>} edge documents
 */
async function readInverseEdges(ctx) {
  const { objectId, edgeCollection, predicate, graphIndex, wrapper } = ctx;
  const edgeIds = graphIndex.incoming(objectId, edgeCollection, predicate);
  const edges = await Promise.all(
    edgeIds.map(id => wrapper.get(edgeCollection, id))
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
      return wrapper.get(null, targetId);
    })
  );
  return targets.filter(Boolean);
}
