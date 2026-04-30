/**
 * @file Residual filter composition and post-scan decoration for QueryBuilder.
 *
 * Extracted from query-builder.js so the pre-commit 260-source-line gate stays
 * satisfied while the main class keeps the chain-method surface. This module
 * layers schema-conditional constraints (supersession, confidence, graph
 * touching) atop the planner residual, and attaches $provenance / hydrated ref
 * sides after execution.
 *
 * @see client/query-builder.js — imports and applies these helpers in toArray()
 */

import { BriQueryError } from '../engine/errors.js';

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
