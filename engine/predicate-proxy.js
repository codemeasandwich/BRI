/**
 * @file Predicate-aware proxy for reactive entities.
 *
 * Implements §2.3 / §2.4 / §3.5 of the spec — when a reactive entity
 * (`alice`) is accessed by a property name that's a registered predicate
 * (`alice.works_at`), the lookup returns a PredicateAccessor that:
 *
 *   - When invoked as a function (`alice.works_at(target, attrs)`):
 *     constructs an edge document and inserts it into the matching edge
 *     collection. Returns a Promise resolving to the new edge entity.
 *
 *   - When awaited as a thenable (`await alice.works_at`): looks up
 *     outgoing edges via the GraphIndex, hydrates target objects, and
 *     resolves to an array of target entities.
 *
 *   - When `.limit(n)` is chained, applies the cap to the read.
 *
 * Property-access lookup (§3.5):
 *   1. If name is a built-in (toJSON/toJSS/save/etc.) — handled by the
 *      reactive proxy upstream of us.
 *   2. If name === 'and' — also handled upstream (back-compat single-hop).
 *   3. If name is a declared field on the target — return raw value (the
 *      reactive proxy's existing fall-through path).
 *   4. If name is a registered predicate where this collection is a valid
 *      `from` endpoint — return a PredicateAccessor (this module).
 *   5. Otherwise — return undefined and let the reactive proxy fall through.
 *
 * The reactive proxy in engine/reactive.js calls `resolvePredicateAccess`
 * with the target, name, and registry. We return a value if we own the
 * lookup or `undefined` if we don't, letting the caller continue its own
 * fallthrough.
 *
 * @implements UC-G1 (one-hop read), edge writes, reserved-name routing
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
  // Declared fields on the entity are not predicates.
  if (name in target) return undefined;
  // Resolve the entity's collection from its $ID prefix.
  const prefix = target.$ID.split('_')[0];
  const subjectCollection = registry.collectionForPrefix(prefix);
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
  // bounded variant.
  const accessor = async function predicateWrite(target, attrs = {}) {
    return writeEdge(ctx, target, attrs);
  };
  accessor.then = (onResolve, onReject) =>
    readTargets(ctx, undefined).then(onResolve, onReject);
  /**
   * Bounded variant: returns a thenable that caps the result to top-k.
   * @param {number} k - Maximum results
   * @returns {Promise<Array>}
   */
  accessor.limit = function limit(k) {
    return {
      then: (onResolve, onReject) =>
        readTargets(ctx, k).then(onResolve, onReject)
    };
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
  const { subjectId, edgeCollection, predicate, edgeSpec, graphIndex, wrapper } = ctx;
  const edgeIds = graphIndex.outgoing(subjectId, edgeCollection, predicate);
  const capped = typeof k === 'number' ? edgeIds.slice(0, k) : edgeIds;
  // Hydrate each edge to learn its `to` field. The edge-collection adjacency
  // already filtered by predicate, so we don't re-check here.
  const edges = await Promise.all(
    capped.map(id => wrapper.get(edgeCollection, id))
  );
  // Then hydrate every target entity. For 'ref|string' polymorphic to
  // fields the value may be a literal string — pass through as-is in v1
  // (the predicate-proxy is meant for full-entity targets per UC-G1).
  const targets = await Promise.all(
    edges.map(edge => {
      const targetId = edge && edge[edgeSpec.to];
      if (!targetId) return null;
      // wrapper.get(null, $ID) is the type-agnostic single fetch — uses
      // the $ID prefix to pick the collection internally.
      return wrapper.get(null, targetId);
    })
  );
  return targets.filter(Boolean);
}
