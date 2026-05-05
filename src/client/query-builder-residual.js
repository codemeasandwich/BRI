/**
 * @file Residual filter composition, candidate-set resolution, and
 * post-scan decoration for QueryBuilder.
 *
 * Extracted from query-builder.js so the pre-commit 260-source-line gate stays
 * satisfied while the main class keeps the chain-method surface. This module
 * layers schema-conditional constraints (supersession, confidence, graph
 * touching) atop the planner residual, resolves the candidate $ID sets for
 * `.touching` (graph adjacency) and `.between` (canonical-pair secondary
 * index, UC-G3), and attaches $provenance / hydrated ref sides after
 * execution.
 *
 * Consumed by: client/query-builder.js (toArray()).
 * Consumes: engine/errors.js (BriQueryError), engine/schema-registry.js
 *   (graphIndex, secondaryIndexManager, canonicalPairKey, edgeSpec).
 *
 * @see client/query-builder.js — imports and applies these helpers in toArray()
 */

import {
  BriQueryError,
  BETWEEN_NOT_A_UNIQUE_SYMMETRIC_EDGE
} from '../engine/errors.js';

/**
 * UC-G3 — fold a `.between` candidate set into a planner output. When
 * `betweenIds` is present (Set of size 0 or 1 from the canonical-pair
 * index lookup), the plan is constrained to ONLY hydrate those IDs:
 *   - if the planner already produced a candidate set (`.where` matched
 *     a $indexes spec), intersect — preserves both filters,
 *   - otherwise upgrade the plan to use the between set directly.
 * Mutates `plan` in place. No-op when `betweenIds` is null.
 *
 * Why intersect rather than override: a chain like
 * `.where({co_occurrence_count: {$gte: 5}}).between(a, b)` should honor
 * BOTH filters; the planner may already have produced a candidate set
 * covering co_occurrence_count.
 *
 * @param {Object} plan - From QueryPlanner.planWhere
 * @param {Set<string>|null} betweenIds
 * @returns {void}
 */
export function applyBetweenConstraint(plan, betweenIds) {
  if (!betweenIds) return;
  if (plan.useIndex && plan.candidateIds) {
    const intersected = new Set();
    for (const id of plan.candidateIds) if (betweenIds.has(id)) intersected.add(id);
    plan.candidateIds = intersected;
  } else {
    plan.useIndex = true;
    plan.candidateIds = betweenIds;
  }
}

/**
 * UC-G3 — validate `.between(nodeA, nodeB)` arguments and return the
 * resolved `{aId, bId}` to stash on QueryBuilder._state. Throws a typed
 * BriQueryError on:
 *   - collection not declared as $edge.unique && symmetric (misuse on
 *     a non-canonical-pair edge collection),
 *   - nodeA / nodeB neither an entity (with $ID) nor a $ID string.
 *
 * Why a free function rather than a method on QueryBuilder: keeps the
 * QueryBuilder class under the 260-NCLOC pre-commit gate, mirrors the
 * `betweenCandidateIds` and `touchingCandidateIds` extraction pattern.
 *
 * @param {Object} ctx - QueryBuilder _ctx ({registry, collection})
 * @param {Object|string} nodeA - Entity (with $ID) or $ID string
 * @param {Object|string} nodeB - Entity (with $ID) or $ID string
 * @returns {{aId:string, bId:string}}
 * @throws {BriQueryError} BETWEEN_NOT_A_UNIQUE_SYMMETRIC_EDGE
 */
export function resolveBetween(ctx, nodeA, nodeB) {
  const { registry, collection } = ctx;
  if (!registry.needsCanonicalPair?.(collection)) {
    throw new BriQueryError({
      code: BETWEEN_NOT_A_UNIQUE_SYMMETRIC_EDGE,
      message:
        `QueryBuilder.between: collection '${collection}' is not declared as a ` +
        `unique-symmetric edge collection ($edge.unique && $edge.symmetric). For ` +
        `predicate-scoped edge lookups (subject, predicate, *), use the predicate ` +
        `proxy instead: 'entity.{predicate}.$' returns all current edges with auto- ` +
        `supersession filtering. For one-hop adjacency on any edge collection, use ` +
        `'.touching([seeds])'.`,
      details: { collection }
    });
  }
  const aId = typeof nodeA === 'string' ? nodeA : (nodeA && nodeA.$ID);
  const bId = typeof nodeB === 'string' ? nodeB : (nodeB && nodeB.$ID);
  if (!aId || !bId) {
    throw new BriQueryError({
      code: BETWEEN_NOT_A_UNIQUE_SYMMETRIC_EDGE,
      message:
        `QueryBuilder.between: nodeA and nodeB must each be an entity (with $ID) ` +
        `or a $ID string. Got nodeA=${typeof nodeA}, nodeB=${typeof nodeB}.`,
      details: { collection, nodeAType: typeof nodeA, nodeBType: typeof nodeB }
    });
  }
  return { aId, bId };
}

/**
 * Layer schema-conditional gates on top of any residual filter the
 * planner produced. The result is a single (doc) → boolean function
 * that the execution paths apply during scan / hydration.
 *
 * @param {Object} args
 * @returns {Function|undefined}
 */
export function composeResidualFilter({
  planResidual, supersedeKey, defaultHideSuperseded, confidence, touching
}) {
  const gates = [];
  if (typeof planResidual === 'function') gates.push(planResidual);
  if (supersedeKey && defaultHideSuperseded) {
    gates.push((doc) => doc && (doc[supersedeKey] === null
                                || doc[supersedeKey] === undefined));
  }
  if (confidence) {
    const { field, threshold } = confidence;
    gates.push((doc) => doc && typeof doc[field] === 'number'
                              && doc[field] >= threshold);
  }
  if (touching) {
    gates.push((doc) => doc && touching.has(doc.$ID));
  }
  if (gates.length === 0) return undefined;
  if (gates.length === 1) return gates[0];
  return (doc) => gates.every(g => g(doc));
}

/**
 * Post-execution decoration: attaches `$provenance` from a schema-
 * declared field and resolves named ref fields via .hydrate.
 *
 * @param {Array<Object>} rows
 * @param {Object} args
 * @param {string|null} args.withProvenance
 * @param {Array<string>} [args.hydrate]
 * @param {Object} args.wrapper
 * @returns {Promise<Array<Object>>}
 */
export async function decorateResults(rows, { withProvenance, hydrate, wrapper }) {
  if (!rows || rows.length === 0) return rows;
  if (withProvenance) {
    for (const row of rows) {
      if (!row) continue;
      const value = row[withProvenance];
      Object.defineProperty(row, '$provenance', {
        value: Array.isArray(value) ? value : (value !== undefined ? [value] : []),
        enumerable: false, configurable: true, writable: false
      });
    }
  }
  if (hydrate && hydrate.length > 0) {
    for (const row of rows) {
      if (!row) continue;
      for (const field of hydrate) {
        const refId = row[field];
        if (typeof refId !== 'string' || refId.length === 0) continue;
        const target = await wrapper.get(null, refId);
        Object.defineProperty(row, `_${field}`, {
          value: target, enumerable: false, configurable: true, writable: false
        });
      }
    }
  }
  return rows;
}

/**
 * Resolve the candidate id set for `.between(nodeA, nodeB)` (UC-G3) over
 * the canonical-pair secondary index of a unique-symmetric edge
 * collection. Returns a Set with 0 or 1 $ID — the uniqueness invariant
 * declared by the schema (`$edge.unique && $edge.symmetric`) guarantees
 * at most one edge per unordered pair.
 *
 * Lookup uses `idxMgr.candidatesFor(collection, {__edgePair: pairKey})`,
 * which keys into the synthetic-field SortedIndex declared by
 * engine/schema-registry.js when the collection's $edge spec set both
 * flags. The pairKey is the lex-sorted [min, max] tuple computed by
 * `registry.canonicalPairKey` so insert and lookup agree on the same
 * canonical form regardless of caller-supplied order.
 *
 * Eligibility (whether the collection is unique-symmetric) is checked at
 * QueryBuilder.between() construction time so misuse fails before any
 * lookup runs; this helper trusts the caller and just executes.
 *
 * Why a Set return type when we expect at most one $ID: matches the
 * shape of `touchingCandidateIds` for uniformity (the toArray dispatcher
 * intersects with plan.candidateIds, also a Set). Empty Set is the
 * correct "no edge" return — caller's `.first()` resolves to null
 * because the executor hydrates an empty candidate list.
 *
 * @param {Object} ctx - QueryBuilder _ctx ({ registry, collection })
 * @param {Object} between - {aId, bId} from QueryBuilder._state.between
 * @returns {Set<string>} 0 or 1 $ID
 */
export function betweenCandidateIds(ctx, between) {
  const { registry, collection } = ctx;
  const pairKey = registry.canonicalPairKey(collection, {
    [registry.edgeSpec(collection).from]: between.aId,
    [registry.edgeSpec(collection).to]:   between.bId
  });
  const out = new Set();
  if (!pairKey) return out;
  const idxMgr = registry.secondaryIndexManager?.();
  if (!idxMgr) return out;
  const candidates = idxMgr.candidatesFor(collection, { __edgePair: pairKey });
  if (!candidates) return out;
  for (const id of candidates.ids) out.add(id);
  return out;
}

/**
 * Resolve the candidate id set for `.touching(seedIds)` over the
 * GraphIndex adjacency for an edge collection.
 *
 * @param {Object} ctx - QueryBuilder _ctx ({ registry, collection })
 * @param {Array<string>} seedIds - Resolved seed $IDs from the chain state
 * @returns {Set<string>}
 * @throws {BriQueryError} when collection is not registered as edge
 */
export function touchingCandidateIds(ctx, seedIds) {
  const { registry, collection } = ctx;
  const spec = registry.edgeSpec?.(collection);
  if (!spec) {
    throw new BriQueryError({
      code: 'TOUCHING_NOT_AN_EDGE_COLLECTION',
      message:
        `QueryBuilder.touching: collection '${collection}' is not registered as an edge collection. Declare $edge in the schema or use .where instead.`,
      details: { collection }
    });
  }
  const out = new Set();
  // graphIndex always returns the shared adjacency bundle from createSchemaRegistry
  // once db.schema wired the registry — there is no null registry graph in prod.
  const graph = registry.graphIndex();
  for (const seedId of seedIds) {
    for (const eid of graph.outgoing(seedId, collection)) out.add(eid);
    for (const eid of graph.incoming(seedId, collection)) out.add(eid);
  }
  return out;
}
