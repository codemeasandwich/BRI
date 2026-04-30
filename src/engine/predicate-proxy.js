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
 *   2. `and` — handled upstream solely in reactive.js (never forwarded here)
 *   3. `inverse` — return InverseProxy whose .{predicate} reads incoming
 *   4. `related` — return RelatedAccessor over all outgoing predicates
 *   5. Declared field — return raw value (reactive proxy fall-through)
 *   6. Registered predicate (subject side) — return PredicateAccessor
 *   7. Otherwise — return undefined; reactive proxy continues. Declared
 *      schema fields shadow predicates and are routed as data reads because
 *      reactive.js invokes predicate resolution only when (!(name in target)).
 *
 * @implements UC-G1 (one-hop read + write + .limit + .$ + inverse + related)
 */

import { type2Short } from '../engine/types.js';
import { expand as runExpand } from './graph-expand.js';
import { makeChainProxy } from './chain-walk.js';
import { makeInverseProxy, makeRelatedAccessor } from './predicate-inverse-related.js';
import {
  BriProxyError, BriValidationError,
  EDGE_ENDPOINT_INVALID
} from './errors.js';

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
  // `and`, `toJSON`, `save`, etc. are resolved in reactive.js before routing here.

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

  // 'expand' is a parameterized BFS — return a callable that runs the
  // graph-expand engine bound to this seed entity. Distinct from .related
  // (which is fixed at one hop, all predicates) — expand takes hops,
  // budget, predicates, direction, edgeFilter.
  if (name === 'expand') {
    return (opts = {}) => runExpand({
      ...opts,
      seedId: target.$ID,
      registry,
      wrapper
    });
  }

  // 'chain' returns a Proxy whose .{field} access walks a self-referential
  // ref field forward (or backward) until null, a cycle, or maxDepth.
  // The accessor is awaitable for default behavior or callable with
  // {maxDepth} for explicit cap.
  if (name === 'chain') {
    if (!subjectCollection) return undefined;
    return makeChainProxy({ target, registry, wrapper, subjectCollection });
  }

  // findEdge / predicate accessors — reactive.js only calls predicate resolution
  // after (!(name in target)), so a non-predicate duplicate field routes as data.
  if (!subjectCollection) return undefined;
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
    // Lifecycle flags drive default-supersession filtering and conditional
    // chain methods — undefined when the edge collection's schema didn't
    // declare $supersession / $confidence / $provenance.
    lifecycle: registry.lifecycleFieldsOf(edgeCollection),
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
  // Default reads filter superseded edges when the edge collection
  // declared $supersession. Chain methods (.history / .confidence(t) /
  // .withProvenance) compose by overriding fields on the read-time ctx.
  const baseReadCtx = { ...ctx, includeSuperseded: false };

  const accessor = async function predicateWrite(target, attrs = {}) {
    return writeEdge(ctx, target, attrs);
  };
  accessor.then = (onResolve, onReject) =>
    readTargets(baseReadCtx, undefined).then(onResolve, onReject);
  accessor.limit = function limit(k) {
    return {
      then: (onResolve, onReject) =>
        readTargets(baseReadCtx, k).then(onResolve, onReject)
    };
  };
  accessor.$ = {
    then: (onResolve, onReject) =>
      readEdges(baseReadCtx, undefined).then(onResolve, onReject)
  };

  // Schema-conditional chain methods — only present when the corresponding
  // field is declared. Per spec §2.2, accessing them on a non-declaring
  // schema is undefined behavior; here we just leave the property absent
  // so the access falls through to the proxy's normal undefined.
  const lc = ctx.lifecycle || {};
  if (lc.supersession) {
    /**
     * History-included read — opts out of the default supersession filter.
     */
    accessor.history = {
      then: (onResolve, onReject) =>
        readTargets({ ...ctx, includeSuperseded: true }, undefined)
          .then(onResolve, onReject)
    };
  }
  if (lc.confidence) {
    /**
     * Threshold-filtered read — keeps edges whose confidence field is
     * >= threshold; missing/non-numeric values are filtered out.
     * @param {number} threshold
     * @returns {Object} thenable
     */
    accessor.confidence = function confidence(threshold) {
      return {
        then: (onResolve, onReject) =>
          readTargets({ ...baseReadCtx, confidenceFloor: threshold }, undefined)
            .then(onResolve, onReject)
      };
    };
  }
  if (lc.provenance) {
    /**
     * Provenance-attached read — same edges/targets as the default, but
     * each result entity carries a non-enumerable $provenance metadata
     * property reflecting the edge's provenance field value.
     */
    accessor.withProvenance = {
      then: (onResolve, onReject) =>
        readTargets({ ...baseReadCtx, attachProvenance: true }, undefined)
          .then(onResolve, onReject)
    };
  }
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
    throw new BriValidationError({
      code: EDGE_ENDPOINT_INVALID,
      message: `Predicate '${predicate}': target must be an entity (with $ID) or a string $ID; got ${typeof target}.`,
      details: { predicate, gotType: typeof target }
    });
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
  // getDb/getDb.attach is assigned by client/proxy.js after the db singleton
  // exists. The only reachable failure mode from createDB callers is `getDb`
  // absent (standalone engine wrappers without `_getDb`).
  const db = getDb && getDb();
  if (!db || !db.add) {
    throw new BriProxyError({
      code: 'EDGE_COLLECTION_UNREACHABLE',
      message:
        `Predicate proxy could not access db.add for edge write. ` +
        `Ensure entities are resolved through createDB's reactive envelope (wrapper._getDb populated).`,
      details: { edgeCollection }
    });
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
  const targets = await hydrateEndpoints(edges, ctx.edgeSpec.to, ctx.wrapper);
  // .withProvenance: attach the provenance field's value as $provenance
  // (non-enumerable so it stays out of toObject / JSON / persistence).
  if (ctx.attachProvenance && ctx.lifecycle && ctx.lifecycle.provenance) {
    const field = ctx.lifecycle.provenance;
    for (let i = 0; i < edges.length && i < targets.length; i++) {
      const edge = edges[i];
      const value = edge && edge[field];
      if (value === undefined || !targets[i]) continue;
      Object.defineProperty(targets[i], '$provenance', {
        value, enumerable: false, configurable: true, writable: false
      });
    }
  }
  return targets;
}

/**
 * Read outgoing edge documents for a subject + predicate, applying the
 * lifecycle-driven default filters (supersession exclusion, confidence
 * threshold) declared by the edge collection's schema.
 *
 * Filter order:
 *   1. Adjacency lookup gives all edge ids for (subject, predicate)
 *   2. Hydrate each edge document
 *   3. Drop superseded edges unless ctx.includeSuperseded
 *   4. Drop edges below ctx.confidenceFloor (if set)
 *   5. Apply k truncation AFTER filtering, so a 5-asked-for result that
 *      finds 7 superseded + 3 valid still returns 3 (not 0).
 *
 * @param {Object} ctx - Bound state plus optional includeSuperseded / confidenceFloor / attachProvenance
 * @param {number|undefined} k - Optional top-k cap
 * @returns {Promise<Array<Object>>} edge documents
 */
async function readEdges(ctx, k) {
  const { subjectId, edgeCollection, predicate, graphIndex, wrapper, lifecycle } = ctx;
  const edgeIds = graphIndex.outgoing(subjectId, edgeCollection, predicate);
  const edges = (await Promise.all(
    edgeIds.map(id => wrapper.get(edgeCollection, id))
  )).filter(Boolean);
  const filtered = applyLifecycleFilters(edges, ctx, lifecycle);
  return typeof k === 'number' ? filtered.slice(0, k) : filtered;
}

/**
 * Apply the lifecycle-driven default filters in order: supersession,
 * then confidence threshold.
 *
 * @param {Array<Object>} edges
 * @param {Object} ctx - Holds includeSuperseded / confidenceFloor flags
 * @param {Object|undefined} lifecycle - {supersession?, confidence?, provenance?}
 * @returns {Array<Object>} filtered edges
 */
function applyLifecycleFilters(edges, ctx, lifecycle) {
  if (!lifecycle) return edges;
  let out = edges;
  if (lifecycle.supersession && !ctx.includeSuperseded) {
    const f = lifecycle.supersession;
    out = out.filter(e => e[f] === undefined || e[f] === null);
  }
  if (lifecycle.confidence && typeof ctx.confidenceFloor === 'number') {
    const f = lifecycle.confidence;
    const threshold = ctx.confidenceFloor;
    out = out.filter(e => typeof e[f] === 'number' && e[f] >= threshold);
  }
  return out;
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

// makeChainProxy + walkChain live in engine/chain-walk.js — extracted to
// keep this file under the 260-source-line gate. The behavior is the same;
// resolvePredicateAccess routes 'chain' there at the top of the file.
