/**
 * @file Chainable query builder for Bri reads
 *
 * Backs the new chainable form `db.get.{collection}S.where(...).near(...)`.
 *
 * Index-aware execution:
 *   When a `.where(filter)` is present, the builder consults the schema
 *   registry's QueryPlanner. If a declared $indexes spec covers (some of)
 *   the filter's fields, the candidate ID set is bounded by that index —
 *   hydration cost becomes O(matches), not O(collection). Residual filter
 *   fields (those not covered by the chosen index) run as a JS predicate
 *   after hydration. When no index applies, behavior matches the previous
 *   full-scan path so collections without $indexes are unaffected.
 *
 * Design:
 *   - Immutable per-link chain: every chain method returns a NEW builder so
 *     that intermediate references don't leak state across two parallel
 *     callers. The cost is small object allocations; the benefit is no
 *     surprise mutation across awaits.
 *   - Thenable: defining a .then() on the builder lets `await builder` work
 *     directly without an explicit .toArray(). Deliberate — it matches the
 *     spec's "executes when awaited" language and keeps simple call sites
 *     readable.
 *   - Vector + filter composition: when both .where and .near are present,
 *     the filter is applied DURING the vector search via predicate (UC-V1
 *     acceptance criterion 3), not as a post-filter.
 *
 * Backwards compatibility:
 *   This module is consumed by the proxy in client/proxy.js. Legacy callers
 *   that invoke `db.get.userS()` (with parens) bypass the builder entirely —
 *   the proxy keeps that path. The builder is constructed lazily on the
 *   first chain-method access so legacy code pays zero overhead.
 *
 * Score metadata:
 *   .near attaches $cosine and $score onto each result entity as
 *   non-enumerable properties. This lets the existing reactive-entity layer
 *   continue to use Object.keys/Object.assign for diffing without picking up
 *   transient ranking metadata.
 *
 * @implements UC-V1 (subset: .where + .near + .limit + .toArray + .first)
 */

import { QueryPlanner } from '../engine/query-planner.js';

/**
 * Compile a filter spec to a predicate function.
 *
 * Accepts a function (passed through) or an object with the equality-form
 * filters used by the existing helpers.checkMatch / isMatch. We don't reach
 * for those modules here to keep the v1 builder self-contained; if filter
 * semantics drift, this is the single place to extend.
 *
 * Supported object form (v1):
 *   { field: value }                  - equality
 *   { field: null }                   - explicit null
 *
 * Future operators ($ne, $in, $gte, etc.) live in the spec but are deferred
 * past this slice. Throwing on an unrecognised operator would be safer; for
 * now we keep object filters strict equality so wrong assumptions surface
 * loudly during the next slice's tests.
 *
 * @param {Object|Function|undefined} filter
 * @returns {(doc:Object)=>boolean}
 */
function compileFilter(filter) {
  if (filter === undefined || filter === null) return () => true;
  if (typeof filter === 'function') return filter;
  if (typeof filter === 'object') {
    const keys = Object.keys(filter);
    return (doc) => {
      if (!doc) return false;
      for (const k of keys) {
        if (doc[k] !== filter[k]) return false;
      }
      return true;
    };
  }
  throw new Error(`QueryBuilder.where: unsupported filter type ${typeof filter}`);
}

/**
 * Attach $cosine and $score as non-enumerable metadata on a result entity.
 *
 * Why non-enumerable: keeps existing toObject/JSON paths unchanged (see
 * tests/e2e/crud.test.js — entities are spread/cloned freely). Callers that
 * want the score read it explicitly via entity.$cosine.
 *
 * @param {Object} entity - Reactive entity from wrapper.get
 * @param {number} score
 * @returns {Object} the same entity with metadata attached
 */
function attachScore(entity, score) {
  Object.defineProperty(entity, '$cosine', {
    value: score, enumerable: false, configurable: true, writable: false
  });
  Object.defineProperty(entity, '$score', {
    value: score, enumerable: false, configurable: true, writable: false
  });
  return entity;
}

/**
 * Chainable query builder.
 *
 * @class QueryBuilder
 */
export class QueryBuilder {
  /**
   * @param {Object} ctx
   * @param {string} ctx.collection - Collection name (without trailing 'S')
   * @param {Object} ctx.wrapper    - Engine wrapper (for hydration)
   * @param {Object} ctx.registry   - Schema registry (for vector index lookup)
   * @param {Object} [state]        - Internal accumulator for chain methods
   */
  constructor(ctx, state = {}) {
    this._ctx = ctx;
    this._state = state;
  }

  /**
   * Branch the chain: returns a new builder with merged state.
   * @param {Object} patch - State fields to merge into the new builder
   * @returns {QueryBuilder} new builder with combined state
   * @private
   */
  _next(patch) {
    return new QueryBuilder(this._ctx, { ...this._state, ...patch });
  }

  /**
   * Attribute filter. Composes with .near via the predicate path so the
   * vector index sees only eligible candidates BEFORE k truncation.
   *
   * @param {Object|Function} filter
   * @returns {QueryBuilder}
   */
  where(filter) {
    return this._next({ filter });
  }

  /**
   * Top-k cosine similarity over the collection's declared vector field.
   *
   * Throws (via toArray) if the collection has no vector field registered or
   * if the query vector has the wrong dimensionality.
   *
   * @param {Array<number>} vector
   * @param {number} k
   * @param {Object} [opts] - Optional per-query overrides
   * @param {string|null} [opts.txnId] - Set to null to force-bypass the
   *   active transaction (search committed-only state); set to an explicit
   *   txnId to query a specific transaction's view; omit to use the active
   *   transaction (default)
   * @returns {QueryBuilder}
   */
  near(vector, k, opts) {
    if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
      throw new Error('QueryBuilder.near: vector must be an array of numbers');
    }
    if (typeof k !== 'number' || k <= 0) {
      throw new Error(`QueryBuilder.near: k must be a positive number; got ${k}`);
    }
    return this._next({ near: { vector, k, opts: opts || null } });
  }

  /**
   * Cap result count. Redundant when .near specifies k, useful for filter-
   * only queries.
   * @param {number} n
   * @returns {QueryBuilder}
   */
  limit(n) {
    return this._next({ limit: n });
  }

  /**
   * Execute the chain.
   *
   * Two paths:
   *   1) .near present: query the VectorIndex with .where as predicate;
   *      hydrate hits to entities; attach $cosine/$score; cap to k (and
   *      .limit if smaller).
   *   2) .near absent: fall back to the existing wrapper.get group call
   *      with the filter; apply .limit on the result list.
   *
   * The two paths use the SAME hydration primitive (wrapper.get(null, $ID))
   * so the entity returned is identical in shape (reactive, has .save()).
   *
   * @returns {Promise<Array<Object>>}
   */
  async toArray() {
    const { collection, wrapper, registry } = this._ctx;
    const { filter, near, limit } = this._state;
    const planner = new QueryPlanner(registry);
    const plan = planner.planWhere(collection, filter);

    if (near) {
      return this._executeVectorPlan(plan, near, limit);
    }
    return this._executeWherePlan(plan, limit);
  }

  /**
   * Execute a `.near` (with optional `.where`) using the planner output.
   *
   * Two paths:
   *   1) plan.useIndex true → predicate fed into searchFiltered uses the
   *      bounded candidate set from the index; hydration is O(k) for ids
   *      already in the index AND in candidate set; further pruned by the
   *      residual filter on the doc body.
   *   2) plan.useIndex false → fallback. If a residual filter exists, we
   *      pre-hydrate the whole collection (the v1 unindexed path) and run
   *      filter-during-search; otherwise we just run pure vector search.
   *
   * @param {Object} plan - From planner.planWhere
   * @param {Object} near - Vector clause; {vector: Array<number>, k: number}
   * @param {number|undefined} limit - Optional cap on result count
   * @returns {Promise<Array<Object>>}
   */
  async _executeVectorPlan(plan, near, limit) {
    const { collection, wrapper, registry, getDb } = this._ctx;
    const index = registry.vectorIndex(collection);
    if (!index) {
      throw new Error(
        `QueryBuilder.near: collection '${collection}' has no vector field ` +
        `declared. Call db.schema('${collection}', { ...embedding: { type: 'vector', dims: N } }).`
      );
    }

    // Active txnId (if any) drives both the index merge path and hydration.
    // Inside a txn, we want searchInTxn (committed + pending) and we want
    // wrapper.get to read txn-shadow doc bodies. Per-query opts on .near
    // can override: opts.txnId === null forces committed-only search even
    // when an active txn is set; opts.txnId === '<id>' targets a specific
    // (possibly non-active) transaction.
    const db = getDb ? getDb() : null;
    let txnId;
    if (near.opts && 'txnId' in near.opts) {
      txnId = near.opts.txnId;  // explicit override (may be null)
    } else {
      txnId = db && db._activeTxnId;
    }
    const getOpts = txnId ? { txnId } : undefined;

    /**
     * Hydrate a single $ID through the wrapper, respecting the active txn.
     * @param {string} id
     * @returns {Promise<Object|null>}
     */
    const hydrate = (id) => getOpts ? wrapper.get(null, id, getOpts) : wrapper.get(null, id);

    /**
     * Run a vector search over the index, picking the committed path or the
     * txn-merging path based on active txnId.
     * @param {number} kArg - top-k size
     * @param {Function|null} pred - optional predicate
     * @returns {Array<{id:string, score:number}>}
     */
    const search = (kArg, pred) => txnId
      ? index.searchInTxn(near.vector, kArg, txnId, pred)
      : index.searchFiltered(near.vector, kArg, pred);

    let hits;
    const docCache = new Map();
    if (plan.useIndex) {
      const candidates = plan.candidateIds;
      if (plan.residualFilter) {
        await Promise.all([...candidates].map(async id => {
          const doc = await hydrate(id);
          if (doc) docCache.set(id, doc);
        }));
        hits = search(near.k,
          (id) => candidates.has(id) && plan.residualFilter(docCache.get(id)));
      } else {
        hits = search(near.k, (id) => candidates.has(id));
      }
    } else if (plan.residualFilter) {
      const all = await wrapper.get(`${collection}S`, getOpts);
      for (const doc of all) {
        if (doc && doc.$ID) docCache.set(doc.$ID, doc);
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
      const entity = docCache.get(id) || await hydrate(id);
      if (entity) out.push(attachScore(entity, score));
    }
    return typeof limit === 'number' ? out.slice(0, limit) : out;
  }

  /**
   * Execute a `.where`-only plan (no `.near`).
   *
   * @param {Object} plan
   * @param {number|undefined} limit
   * @returns {Promise<Array<Object>>}
   */
  async _executeWherePlan(plan, limit) {
    const { collection, wrapper } = this._ctx;
    if (plan.useIndex) {
      // Hydrate only the candidate set; apply residual filter post-hydration.
      const ids = [...plan.candidateIds];
      const docs = await Promise.all(ids.map(id => wrapper.get(null, id)));
      const filtered = plan.residualFilter
        ? docs.filter(doc => doc && plan.residualFilter(doc))
        : docs.filter(Boolean);
      return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
    }
    const all = await wrapper.get(`${collection}S`);
    const filtered = plan.residualFilter ? all.filter(plan.residualFilter) : all;
    return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
  }

  /**
   * Convenience terminal: first match or null.
   * @returns {Promise<Object|null>}
   */
  async first() {
    const arr = await this.toArray();
    return arr.length > 0 ? arr[0] : null;
  }

  /**
   * Thenable: makes `await builder` work without an explicit .toArray().
   * @param {Function} onResolve - Forwarded to the underlying Promise
   * @param {Function} onReject - Forwarded to the underlying Promise
   * @returns {Promise<Array>} resolves with the toArray() result
   */
  then(onResolve, onReject) {
    return this.toArray().then(onResolve, onReject);
  }
}

export default QueryBuilder;
