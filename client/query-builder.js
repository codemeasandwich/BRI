/**
 * @file Chainable query builder for Bri reads (the surface behind
 * `db.get.{collection}S.where(...).near(...)`).
 *
 * Role in the system:
 *   This module is the user-facing chain syntax for everything except the
 *   legacy callable form (`db.get.userS(...)` — preserved by proxy.js).
 *   Every read primitive that has chain ergonomics — .where, .near, .match,
 *   .limit, .count, .distinct, .groupBy, .first, .toArray — terminates here
 *   or in a sibling module that this one delegates to.
 *
 * Dependencies (what this relies on):
 *   - engine/query-planner.js  → QueryPlanner.planWhere turns .where into
 *                                a {useIndex, candidateIds, residualFilter}
 *                                shape; index-aware paths use the candidate
 *                                set, scan paths use the residual filter
 *   - engine/filter-compiler.js → indirectly, via QueryPlanner; also via
 *                                GroupedQueryBuilder.having
 *   - engine/vector-index.js   → for .near via registry.vectorIndex; the
 *                                builder never imports it directly
 *   - client/grouped-query-builder.js → produced by .groupBy(field)
 *   - client/match-engine.js   → produced by .match() and .combine();
 *                                extracted to keep this file under the
 *                                260-source-line gate
 *
 * Consumers (what relies on this):
 *   - client/proxy.js          → the hybrid get-proxy returns a bound chain
 *                                method when CHAIN_METHODS contains the
 *                                accessed name; otherwise falls back to the
 *                                legacy callable. Adding a new chain method
 *                                requires updating CHAIN_METHODS in proxy.js
 *   - engine/predicate-proxy.js → uses the same metadata-attach convention
 *                                ($cosine / $score / $matchHits / $provenance)
 *                                so chain-method-attached fields and predicate-
 *                                attached fields read alike at the call site
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
 * Design choices and why:
 *   - **Immutable per-link chain.** Every chain method returns a NEW builder
 *     so that intermediate references don't leak state across two parallel
 *     callers. The cost is small object allocations; the benefit is no
 *     surprise mutation across awaits — a common foot-gun in fluent APIs.
 *   - **Thenable.** Defining a .then() on the builder lets `await builder`
 *     work directly without an explicit .toArray(). Deliberate — matches
 *     the spec's "executes when awaited" language; the spec example
 *     `await db.get.{coll}S.near(v, 5)` works because of this.
 *   - **Vector + filter composition during traversal.** When both .where
 *     and .near are present, the filter is applied DURING the vector
 *     search via predicate (UC-V1 acceptance criterion 3), not as a post-
 *     filter. Otherwise k-truncation could drop eligible candidates and
 *     return fewer than k results when more were available.
 *   - **Heavy execution paths delegate to sibling modules.** ._executeMatchPlan
 *     and ._executeCombinedPlan are one-liners here; the actual scan +
 *     scoring + blending lives in client/match-engine.js because (a) it
 *     keeps this file under the pre-commit hook's 260-source-line gate
 *     and (b) match scoring is a v2 expansion target (TF-IDF, fuzzy,
 *     persistent FTS index) — isolating it from the chain ergonomics
 *     means future scoring changes don't risk the chain semantics.
 *
 * Backwards compatibility:
 *   Legacy callers that invoke `db.get.userS()` (with parens) bypass the
 *   builder entirely — proxy.js keeps that path. The builder is constructed
 *   lazily on the first chain-method access so legacy code pays zero
 *   overhead.
 *
 * Search-result metadata convention:
 *   Chain methods that produce ranked results attach non-enumerable fields
 *   to each entity:
 *     - $cosine     vector similarity (set by .near and .combine)
 *     - $score      composite score (set by .combine; equals $cosine when
 *                   only .near contributed)
 *     - $matchHits  {field, value} for the substring that matched (.match
 *                   and .combine)
 *     - $provenance optional metadata from the predicate proxy's
 *                   .withProvenance chain (separate path, but same
 *                   non-enumerable convention)
 *   Non-enumerability keeps the reactive-entity layer's Object.keys /
 *   Object.assign diffing clean — these transient ranking fields don't
 *   leak into persistence.
 *
 * @implements UC-V1 (.where + .near + .limit + .toArray + .first),
 *             UC-X3 (.count + .distinct + .groupBy via GroupedQueryBuilder),
 *             UC-X4 (.match — substring FTS scan),
 *             UC-V3 (.combine — weighted alias + vector blend)
 */

import { QueryPlanner } from '../engine/query-planner.js';
import { GroupedQueryBuilder } from './grouped-query-builder.js';
import { executeMatch, executeCombined } from './match-engine.js';

// compileFilter lives in engine/filter-compiler.js — shared with the
// query planner and the GroupedQueryBuilder so .where, .having, and the
// planner's residual filter all agree on operator semantics.

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
   * Substring match on string-or-array fields (UC-X4). Pass a single-field
   * filter object `{fieldName: 'query'}`; the field's value is checked for
   * case-insensitive substring containment (or, if the field is an array,
   * containment of the substring in any element). Optional `k` caps results.
   *
   * v1 behavior: binary score {0, 1} per doc; equal-score ties broken by
   * `updatedAt` desc (recency). v2 will add stemming + stop-word filtering.
   * Composes with `.where` for prefilter and with `.near` + `.combine` for
   * weighted alias+vector blending (UC-V3).
   *
   * @param {Object} stringFilter - Single-field substring filter
   * @param {number} [k] - Optional top-k cap
   * @returns {QueryBuilder}
   */
  match(stringFilter, k) {
    if (!stringFilter || typeof stringFilter !== 'object') {
      throw new Error('QueryBuilder.match: requires a {field: substring} object');
    }
    return this._next({ match: { filter: stringFilter, k } });
  }

  /**
   * Weighted blend of `.match` and `.near` scores into a single ranked
   * result set (UC-V3). REQUIRES both `.match` and `.near` to have been
   * declared earlier in the chain — without both, calling `.toArray()`
   * throws with a diagnostic.
   *
   * Each result is scored as:
   *   $score = weights.alias * matchScore + weights.vector * cosine
   * with matchScore ∈ {0, 1} and cosine in [-1, 1] (typically [0, 1] for
   * normalized embeddings). Docs missing one component (e.g., no embedding)
   * still rank via the other — `null_embedding_eligible_via_alias`.
   *
   * Result entities carry `$score`, `$cosine`, and `$matchHits` so callers
   * can audit the blend.
   *
   * @param {Object} weights - {alias: number, vector: number}
   * @returns {QueryBuilder}
   */
  combine(weights) {
    if (!weights || typeof weights !== 'object'
        || typeof weights.alias !== 'number'
        || typeof weights.vector !== 'number') {
      throw new Error(
        'QueryBuilder.combine: requires {alias: number, vector: number}'
      );
    }
    return this._next({ combine: weights });
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
    const { filter, near, match, combine, limit } = this._state;
    const planner = new QueryPlanner(registry);
    const plan = planner.planWhere(collection, filter);

    // Routing matrix:
    //   .combine present → must have .match AND .near; weighted blend
    //   .match + .near (no combine) → ambiguous; throw with diagnostic
    //   .match alone → substring scan with recency tiebreak
    //   .near alone → existing vector path
    //   .where only → existing where path
    if (combine) {
      if (!match || !near) {
        throw new Error(
          'QueryBuilder.combine: requires both .match(...) and .near(...) ' +
          'to have been declared earlier in the chain.'
        );
      }
      return this._executeCombinedPlan(plan, match, near, combine, limit);
    }
    if (match && near) {
      throw new Error(
        'QueryBuilder: .match and .near in the same chain require .combine ' +
        'to specify how their scores blend. Add .combine({alias, vector}).'
      );
    }
    if (match) return this._executeMatchPlan(plan, match, limit);
    if (near)  return this._executeVectorPlan(plan, near, limit);
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
  /**
   * Execute a `.match`-only chain. Delegates to match-engine.executeMatch
   * which encapsulates the substring scan, scoring, recency tiebreak, and
   * $matchHits attribution. Kept as a one-liner here so the dispatcher in
   * toArray() reads cleanly; the heavy lifting and rationale live in the
   * helper module.
   *
   * @param {Object} plan - From QueryPlanner.planWhere
   * @param {Object} match - {filter, k}
   * @param {number|undefined} limit
   * @returns {Promise<Array<Object>>}
   */
  async _executeMatchPlan(plan, match, limit) {
    const { collection, wrapper } = this._ctx;
    return executeMatch({ plan, match, limit, collection, wrapper });
  }

  /**
   * Execute a `.match` + `.near` + `.combine` chain. Delegates to
   * match-engine.executeCombined which handles the candidate-set blend
   * (matchScore + cosine via the VectorIndex), the
   * null_embedding_eligible_via_alias case, and the $score / $cosine /
   * $matchHits audit-trail metadata.
   *
   * @param {Object} plan
   * @param {Object} match
   * @param {Object} near
   * @param {Object} weights - {alias, vector}
   * @param {number|undefined} limit
   * @returns {Promise<Array<Object>>}
   */
  async _executeCombinedPlan(plan, match, near, weights, limit) {
    const { collection, registry, wrapper } = this._ctx;
    return executeCombined({
      plan, match, near, weights, limit, collection, registry, wrapper
    });
  }

  /**
   * Execute a `.where`-only chain (no `.near` / `.match` / `.combine`).
   * If the planner found an index hit, hydrates only the candidate set and
   * applies the residual filter post-hydration. Otherwise falls back to
   * the engine's group-get over the full collection with the filter as a
   * residual JS predicate.
   *
   * @param {Object} plan - From QueryPlanner.planWhere
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
   * Terminal: returns the count of matching docs. Composes with .where but
   * not with .near (count-of-similar isn't well-defined as a primitive yet).
   * @returns {Promise<number>}
   */
  async count() {
    if (this._state.near) {
      throw new Error('QueryBuilder.count() does not compose with .near (yet)');
    }
    const arr = await this.toArray();
    return arr.length;
  }

  /**
   * Terminal: returns the distinct values of a field across matching docs.
   * @param {string} field
   * @returns {Promise<Array>} distinct values, in insertion order
   */
  async distinct(field) {
    if (this._state.near) {
      throw new Error('QueryBuilder.distinct() does not compose with .near (yet)');
    }
    const arr = await this.toArray();
    const seen = new Set();
    const out = [];
    for (const doc of arr) {
      if (!doc) continue;
      const v = doc[field];
      if (v === undefined || v === null) continue;
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  /**
   * Build a GroupedQueryBuilder for the given grouping field. The grouped
   * builder takes additional terminals (.count, .sum) and an optional
   * .having filter applied to aggregated rows.
   *
   * @param {string} field
   * @returns {GroupedQueryBuilder}
   */
  groupBy(field) {
    return new GroupedQueryBuilder(this, field);
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

// GroupedQueryBuilder lives in client/grouped-query-builder.js — extracted
// to keep this file under the 260-source-line gate. Re-exported here so
// callers that imported it from query-builder.js still resolve correctly.
export { GroupedQueryBuilder };

export default QueryBuilder;
