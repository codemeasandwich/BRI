/**
 * @file Vector search execution path for QueryBuilder (.near chains).
 *
 * Holds attachScore and executeVectorPlan so query-builder.js stays under the
 * 260-source-line pre-commit gate. UC-V1/V2/V4 routing through VectorIndex is
 * documented on the exported executeVectorPlan function.
 *
 * @see client/query-builder.js — delegates here from toArray()'s `.near` branch
 */

import {
  BriQueryError,
  VECTOR_FIELD_NOT_DECLARED
} from '../engine/errors.js';

/**
 * Attach $cosine and $score as non-enumerable metadata on a result entity
 * produced by the `.near()` path.
 *
 * @param {Object} entity - Reactive entity from wrapper.get
 * @param {number} score - Cosine similarity
 * @returns {Object} the same entity reference (mutated in place)
 */
export function attachScore(entity, score) {
  Object.defineProperty(entity, '$cosine', {
    value: score, enumerable: false, configurable: true, writable: false
  });
  Object.defineProperty(entity, '$score', {
    value: score, enumerable: false, configurable: true, writable: false
  });
  return entity;
}

/**
 * Execute a `.near` (with optional `.where`) using the planner output.
 * UC-V1 (vanilla top-k), UC-V2 (where prefilter), UC-V4 (txn merge).
 *
 * @param {Object} ctx - QueryBuilder _ctx
 * @param {Object} plan - From QueryPlanner.planWhere
 * @param {Object} near - { vector, k, opts }
 * @param {number|undefined} limit - Outer .limit
 * @returns {Promise<Array<Object>>}
 */
export async function executeVectorPlan(ctx, plan, near, limit) {
  const { collection, wrapper, registry, getDb } = ctx;
  const index = registry.vectorIndex(collection);
  if (!index) {
    throw new BriQueryError({
      code: VECTOR_FIELD_NOT_DECLARED,
      message:
        `QueryBuilder.near: collection '${collection}' has no vector field declared. Call db.schema('${collection}', { ...embedding: { type: 'vector', dims: N } }).`,
      details: { collection }
    });
  }

  const db = getDb?.();
  let txnId;
  if (near.opts && 'txnId' in near.opts) {
    txnId = near.opts.txnId;
  } else {
    txnId = db && db._activeTxnId;
  }
  const getOpts = txnId ? { txnId } : undefined;

  /**
   * Hydrate one $ID through wrapper.get with txn opts when bound.
   * @param {string} id
   * @returns {Promise<Object|undefined>}
   */
  const hydrateOne = (id) => getOpts
    ? wrapper.get(null, id, getOpts)
    : wrapper.get(null, id);

  const searchOpts = near.opts && typeof near.opts.efSearch === 'number'
    ? { efSearch: near.opts.efSearch }
    : undefined;

  /**
   * Run vector search (txn-merged or committed-only).
   * @param {number} kArg
   * @param {Function|null} pred
   * @returns {Array<{id:string, score:number}>}
   */
  const search = (kArg, pred) => txnId
    ? index.searchInTxn(near.vector, kArg, txnId, pred, searchOpts)
    : index.searchFiltered(near.vector, kArg, pred, searchOpts);

  let hits;
  const docCache = new Map();
  if (plan.useIndex) {
    const candidates = plan.candidateIds;
    if (plan.residualFilter) {
      await Promise.all([...candidates].map(async id => {
        const doc = await hydrateOne(id);
        doc && docCache.set(id, doc);
      }));
      hits = search(near.k,
        (id) => candidates.has(id) && plan.residualFilter(docCache.get(id)));
    } else {
      hits = search(near.k, (id) => candidates.has(id));
    }
  } else if (plan.residualFilter) {
    const all = await wrapper.get(`${collection}S`, getOpts);
    for (const doc of all) {
      doc?.$ID && docCache.set(doc.$ID, doc);
    }
    hits = search(near.k, (id) => {
      const doc = docCache.get(id);
      return !!doc && plan.residualFilter(doc);
    });
  } else {
    hits = search(near.k, null);
  }

  const out = [];
  for (const { id, score } of hits) {
    const entity = docCache.get(id) || await hydrateOne(id);
    if (entity) out.push(attachScore(entity, score));
  }
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}
