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
 * Attach $cosine and $score as non-enumerable metadata on a result entity
 * produced by the `.near()` path.
 *
 * Used by: `_executeVectorPlan` only — `.combine` and `.match` paths use
 *   the parallel `attachMeta` helper in match-engine.js because they have
 *   richer metadata to attach ($matchHits, separated $score/$cosine when
 *   the blend is non-trivial). The two helpers honor the same convention
 *   intentionally so call sites that read entity.$cosine work uniformly
 *   regardless of which path produced the result.
 *
 * Why non-enumerable: the reactive-entity layer in engine/reactive.js
 * spreads / Object.assigns / JSON-stringifies these all over the place
 * (tests/e2e/crud.test.js cycles them through Object.keys repeatedly).
 * Enumerable transient ranking fields would leak into save() diffs and
 * toObject() output. Defining them with `enumerable: false` keeps the
 * persistence layer ignorant of these fields while still making them
 * trivially accessible at the call site.
 *
 * Why writable: false: the builder owns the score; mutating it after
 * the fact would silently desync from $matchHits / $provenance set by
 * other paths. Read-only is the right contract.
 *
 * @param {Object} entity - Reactive entity from wrapper.get
 * @param {number} score - Cosine similarity (also assigned to $score
 *   because the .near path has only one ranking signal)
 * @returns {Object} the same entity reference (mutated in place)
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
 * Chainable query builder — the user-facing chain syntax produced by the
 * hybrid get-proxy in client/proxy.js when a property name in CHAIN_METHODS
 * is accessed on db.get.{collection}S.
 *
 * Lifetime: one builder per chain. Every method returns a NEW builder with
 * merged state (immutable per-link), so two parallel call sites starting
 * from the same db.get.{coll}S can chain independently without leaking.
 * The cost is small allocation per chain link; the benefit is no surprise
 * mutation across awaits, which is the most common foot-gun in fluent
 * APIs.
 *
 * State shape (this._state):
 *   - filter      object filter or function from .where
 *   - near        {vector, k, opts} from .near
 *   - match       {filter, k} from .match
 *   - combine     {alias, vector} weights from .combine
 *   - limit       integer cap from .limit
 *
 * Execution shape (this._ctx, fixed at construction):
 *   - collection  collection name without trailing 'S'
 *   - wrapper     engine wrapper for store + reactive hydration
 *   - registry    schema registry — vector index, secondary indexes,
 *                 graph index, lifecycle flags, planner inputs
 *   - getDb       lazy db accessor for txn-aware reads (.near opts)
 *
 * @class QueryBuilder
 */
export class QueryBuilder {
  /**
   * Construct a fresh builder. Called once at the start of a chain by the
   * proxy in client/proxy.js (createGetProxy → CHAIN_METHODS branch); chain
   * methods then call _next() to produce derived builders rather than
   * mutating in place.
   *
   * @param {Object} ctx - Fixed execution context shared across the chain
   * @param {string} ctx.collection - Collection name without trailing 'S'
   * @param {Object} ctx.wrapper    - Engine wrapper (for hydration + writes)
   * @param {Object} ctx.registry   - Schema registry (for vector index, planner)
   * @param {Function} [ctx.getDb]  - Lazy db accessor (for txn-aware .near)
   * @param {Object} [state]        - Internal accumulator (chain methods only)
   */
  constructor(ctx, state = {}) {
    this._ctx = ctx;
    this._state = state;
  }

  /**
   * Branch the chain: produce a new builder with the patch merged into
   * state. This is the immutability mechanism — every public chain method
   * funnels through here so the caller's builder reference stays unchanged.
   *
   * Why merge instead of replace: chain methods are independent (e.g.
   * .where + .near + .limit each set different keys) and order shouldn't
   * matter to most users. Spread-merge keeps the ergonomics flat.
   *
   * @param {Object} patch - State keys to overlay onto the new builder
   * @returns {QueryBuilder} new instance sharing the same _ctx
   * @private
   */
  _next(patch) {
    return new QueryBuilder(this._ctx, { ...this._state, ...patch });
  }

  /**
   * Attribute filter. Compiled by engine/filter-compiler.js (shared with
   * .having and the planner's residual filter so $gte/$in/etc. agree
   * across all three paths).
   *
   * Composition with .near: the resulting predicate is fed into
   * VectorIndex.searchFiltered DURING the search, not as a post-filter.
   * This is UC-V1 acceptance criterion 3 — without it, k-truncation could
   * drop eligible candidates and a search asking for top-5 facts could
   * return fewer than 5 even when more existed.
   *
   * Composition with the secondary-index planner: when a declared $indexes
   * spec covers (some of) the filter's fields, the planner returns a
   * candidate-id set that bounds the work; the residual fields run as a
   * JS predicate. Operator-clause fields (e.g. {score: {$gte: 5}}) always
   * fall to the residual path (v1 indexes don't do range — see
   * engine/secondary-index.js).
   *
   * @param {Object|Function} filter - Object filter (compiled per spec
   *   §2.2 operators) or arbitrary predicate function
   * @returns {QueryBuilder} new builder with state.filter set
   */
  where(filter) {
    return this._next({ filter });
  }

  /**
   * Top-k cosine similarity over the collection's declared vector field
   * (UC-V1). Resolved at execution time via registry.vectorIndex(collection);
   * the actual search uses VectorIndex.searchFiltered or searchInTxn, picked
   * by _executeVectorPlan based on the active transaction.
   *
   * Composition:
   *   - With `.where`: planner's candidate set becomes the searchFiltered
   *     predicate so the index never scores docs that fail the filter
   *     (UC-V1 criterion 3 — filter applied before k truncation).
   *   - With `.match` + `.combine`: this method's k is the cap on the
   *     blended ranking; the math lives in match-engine.executeCombined.
   *   - With an active transaction: searchInTxn merges committed + pending
   *     edges so writers see their own staged inserts (UC-V4); the
   *     `opts.txnId` override forces committed-only or targets a specific
   *     transaction.
   *
   * Throws (via toArray) if the collection has no vector field registered
   * or if the query vector has the wrong dimensionality. The throw is
   * deferred to .toArray() so chain construction doesn't surface schema
   * errors before the user has finished composing the query.
   *
   * @param {Array<number>|Float32Array} vector - Query embedding;
   *   dimensionality must match the schema's `dims`
   * @param {number} k - Top-k cap on results
   * @param {Object} [opts] - Optional per-query overrides
   * @param {string|null} [opts.txnId] - `null` forces committed-only
   *   search (bypasses the active transaction); a string targets a
   *   specific txn; omitted = use the active txn (default behavior)
   * @returns {QueryBuilder} new builder with state.near set
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
   * Substring match on string-or-array fields (UC-X4 / FTS).
   *
   * Implementation lives in client/match-engine.js (executeMatch); this
   * method only stores the clause in builder state and the dispatcher in
   * toArray() routes it. Extraction rationale: keeps this file under the
   * 260-source-line gate AND isolates the v2 scoring expansion target
   * (stemming / TF-IDF / persistent FTS index per spec §6.2) from the
   * chain ergonomics here.
   *
   * Filter shape: `{fieldName: 'query'}`. Multi-field filters are accepted
   * as logical-OR (any field containing its query passes); first-match
   * wins for $matchHits attribution. Case-insensitive by default —
   * adopters typically have mixed-case alias / content data.
   *
   * Composition:
   *   - With `.where`: planner-bounded candidate set scopes the scan.
   *   - With `.near` + `.combine`: weighted blend in match-engine.
   *   - With `.near` WITHOUT `.combine`: ambiguous — toArray() throws.
   *
   * @param {Object} stringFilter - {field: substring, ...}
   * @param {number} [k] - Optional top-k cap; combined with `.limit` via
   *   `Math.min` when both are present
   * @returns {QueryBuilder} new builder with state.match set
   * @throws {Error} when stringFilter isn't a plain object
   */
  match(stringFilter, k) {
    if (!stringFilter || typeof stringFilter !== 'object') {
      throw new Error('QueryBuilder.match: requires a {field: substring} object');
    }
    return this._next({ match: { filter: stringFilter, k } });
  }

  /**
   * Weighted blend of `.match` and `.near` scores (UC-V3 hybrid retrieval).
   * Requires both `.match` and `.near` earlier in the chain — toArray()
   * throws otherwise. Implementation lives in match-engine.executeCombined.
   *
   * Why a separate chain method instead of overloading .near or .match
   * with weights: the spec's UC-V3 example shows the user explicitly
   * declaring their blend weights at the call site. Making .combine
   * mandatory keeps the policy visible — silently default-blending two
   * mixed-modality queries would produce surprising rankings depending
   * on whether the user remembered to set weights.
   *
   * Math (executed by match-engine.executeCombined):
   *   $score = weights.alias * matchScore + weights.vector * cosine
   *   matchScore ∈ {0, 1} (binary substring match)
   *   cosine    ∈ [-1, 1] (typically [0, 1] for normalized embeddings)
   *   missing component → that contribution is 0 (so a doc with no
   *     embedding still ranks via alias alone — UC-V3 invariant
   *     null_embedding_eligible_via_alias)
   *   blended === 0 → dropped (no component contributed)
   *
   * Audit-trail metadata on each result:
   *   $score        the blended composite
   *   $cosine       raw vector cosine (or 0 if doc had no embedding)
   *   $matchHits    {field, value} for the matched substring (if any)
   *
   * @param {Object} weights - {alias: number, vector: number}; both required
   * @returns {QueryBuilder} new builder with state.combine set
   * @throws {Error} when weights doesn't have both alias + vector as numbers
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
   * Cap result count. Redundant when `.near(vector, k)` or `.match(filter, k)`
   * already specifies a top-k; useful for the .where-only path or when the
   * caller wants a smaller cap than the upstream k.
   *
   * Interaction with chain-supplied caps:
   *   - .near(v, 20).limit(5)  → returns 5 (slice after vector top-20)
   *   - .match(f, 20).limit(5) → returns 5 (Math.min in match-engine)
   *   - .where(f).limit(5)     → returns 5 (slice after scan)
   *
   * @param {number} n - Maximum result count
   * @returns {QueryBuilder} new builder with state.limit set
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
   * The most-trafficked path in the builder — UC-V1 (vanilla top-k),
   * UC-V2 (with .where prefilter), and UC-V4 (transaction-isolated reads)
   * all flow through here.
   *
   * Three sub-paths chosen by plan + state shape:
   *   1) plan.useIndex true (secondary index covers all .where fields):
   *      hydrate ONLY the candidate set (one round-trip per id), then
   *      feed the candidate-set predicate into searchFiltered. Hydration
   *      cost is O(k), independent of collection size — UC-V1 acceptance
   *      criterion 3 plus the bounded-hydration test in
   *      tests/e2e/secondary-index.test.js.
   *   2) plan.useIndex false BUT a residual filter exists (.where on
   *      unindexed fields): fall back to full-collection hydration so
   *      the residual filter can apply during the vector search. v1
   *      scale acceptable; v2 may add a smarter "hydrate-only-vector-
   *      hits" path that re-checks the filter post-hydration.
   *   3) No filter: pure vector search via searchFiltered with no
   *      predicate — the fastest path.
   *
   * Transaction integration:
   *   When db._activeTxnId is set, switches to VectorIndex.searchInTxn
   *   so the writer sees its own staged inserts (UC-V4); hydration
   *   passes the txnId through to wrapper.get so doc bodies come from
   *   the txn shadow state. opts.txnId on .near overrides — null forces
   *   committed-only, '<id>' targets a specific txn.
   *
   * Why a single function instead of three: the cosine search call site
   * is identical except for the predicate / k; splitting would duplicate
   * the metadata-attach logic at the bottom and risk drift between paths.
   *
   * @param {Object} plan - From QueryPlanner.planWhere
   * @param {Object} near - Vector clause {vector, k, opts}
   * @param {number|undefined} limit - Outer .limit if present
   * @returns {Promise<Array<Object>>} hydrated result entities with
   *   $cosine + $score attached (via attachScore)
   * @throws {Error} when the collection has no vector field declared
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
   * Convenience terminal: first match or `null` if the result set is empty.
   *
   * Composition: works on every other chain (where / near / match /
   * combine / limit). Internally awaits toArray() and returns the head
   * — there's no separate "limit 1" optimization yet because the chain
   * already truncates appropriately for vector and match paths; pure
   * .where could optimize but the savings at v1 scale are negligible.
   *
   * @returns {Promise<Object|null>}
   */
  async first() {
    const arr = await this.toArray();
    return arr.length > 0 ? arr[0] : null;
  }

  /**
   * Terminal: count of matching docs (UC-X3).
   *
   * Composition: works with .where (and operator filters via the shared
   * filter-compiler). DOES NOT compose with .near — the spec scopes
   * "count of similar vectors" out of v1 because the semantics aren't
   * well-defined (count of all? count above some threshold? count where
   * cosine is in some range?). Throws with a diagnostic when .near is
   * present so the user makes the policy explicit instead.
   *
   * @returns {Promise<number>}
   * @throws {Error} when .near is in the chain
   */
  async count() {
    if (this._state.near) {
      throw new Error('QueryBuilder.count() does not compose with .near (yet)');
    }
    const arr = await this.toArray();
    return arr.length;
  }

  /**
   * Terminal: distinct values of `field` across the result set (UC-X3).
   *
   * Order preservation: insertion order, NOT sort order. Spec example
   * uses .distinct for unique-id enumeration where order doesn't matter;
   * imposing sort would surprise callers who expect "the natural order
   * the matches came in".
   *
   * Null/undefined values: dropped silently (no entries for absent
   * fields). The Set + push pattern ensures one entry per distinct value
   * and stable order.
   *
   * Composition: same restriction as count — does not compose with .near.
   *
   * @param {string} field - Name of the field whose distinct values to collect
   * @returns {Promise<Array>} distinct values in encounter order
   * @throws {Error} when .near is in the chain
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
   * Open a GroupedQueryBuilder for aggregation (UC-X3). Returns a sibling
   * builder defined in client/grouped-query-builder.js — that module owns
   * the .count() / .sum(field) / .having(filter) chain methods because
   * the result-row shape (`{<groupField>: value, count|sum: number}`)
   * differs from the document-row shape this QueryBuilder produces.
   *
   * Why pass `this` to the GroupedQueryBuilder ctor: the grouped builder
   * needs to re-execute the upstream chain (the .where filter, etc.)
   * before grouping. Storing the parent reference lets it call
   * parent.toArray() rather than reconstructing the state.
   *
   * @param {string} field - Field to group by (single-field only in v1)
   * @returns {GroupedQueryBuilder}
   */
  groupBy(field) {
    return new GroupedQueryBuilder(this, field);
  }

  /**
   * Thenable interface — defines the .then() Promise contract on the
   * builder so `await builder` works directly without an explicit
   * .toArray() call.
   *
   * Why thenable instead of returning a Promise from chain methods:
   *   - chain methods need to return ANOTHER builder so further chain
   *     methods compose (.where(...).near(...).limit(...))
   *   - making the builder itself awaitable means the user can write
   *     `await db.get.userS.near(v, 5)` without a trailing `.toArray()`,
   *     matching the spec example phrasing
   *   - JS's await unwraps any object with a callable .then; we don't
   *     need to inherit from Promise (which would lose the chainable
   *     methods after the first .then)
   *
   * @param {Function} onResolve - Forwarded to toArray()'s underlying Promise
   * @param {Function} onReject  - Forwarded similarly
   * @returns {Promise<Array<Object>>} resolves with the result array
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
