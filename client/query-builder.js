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
 *   - client/match-engine.js   → produced by .match() and .combine()
 *   - client/query-builder-residual.js → composeResidualFilter / decorate /
 *                                touchingCandidateIds for the 260-line gate
 *   - client/query-builder-vector-exec.js → attachScore / executeVectorPlan
 *   - client/query-builder-where-exec.js → executeWherePlan (.where-only path)
 *   - client/query-builder-terminals.js → first / count / distinct terminals
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
import {
  BriQueryError,
  NOT_IMPLEMENTED_V1
} from '../engine/errors.js';
import {
  composeResidualFilter,
  decorateResults,
  touchingCandidateIds
} from './query-builder-residual.js';
import { executeVectorPlan } from './query-builder-vector-exec.js';
import { executeWherePlan } from './query-builder-where-exec.js';
import {
  queryBuilderFirst,
  queryBuilderCount,
  queryBuilderDistinct
} from './query-builder-terminals.js';

// compileFilter lives in engine/filter-compiler.js — shared with the
// query planner and the GroupedQueryBuilder so .where, .having, and the
// planner's residual filter all agree on operator semantics.

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
   * by executeVectorPlan (query-builder-vector-exec.js) based on txn state.
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
   * @param {number} [opts.efSearch] - HNSW query-time candidate-set size
   *   (v2 §6.2). Higher values trade latency for recall. Default lives
   *   on the VectorIndex (50). Override per-query when the workload
   *   needs tighter recall than the default frontier provides.
   * @returns {QueryBuilder} new builder with state.near set
   */
  near(vector, k, opts) {
    if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
      throw new BriQueryError({
        code: 'NEAR_VECTOR_INVALID',
        message: 'QueryBuilder.near: vector must be an array of numbers (or a Float32Array).',
        details: { gotType: typeof vector }
      });
    }
    if (typeof k !== 'number' || k <= 0) {
      throw new BriQueryError({
        code: 'NEAR_K_INVALID',
        message: `QueryBuilder.near: k must be a positive number; got ${k}.`,
        details: { k }
      });
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
      throw new BriQueryError({
        code: 'MATCH_FILTER_INVALID',
        message: 'QueryBuilder.match: requires a {field: substring} object.',
        details: { gotType: typeof stringFilter }
      });
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
      throw new BriQueryError({
        code: 'COMBINE_WEIGHTS_INVALID',
        message: 'QueryBuilder.combine: requires {alias: number, vector: number}.',
        details: { got: weights }
      });
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
   * Edge-collection: filter to edges where any `from`/`to` field references
   * any seed id (UC-G1). Resolves via the GraphIndex adjacency in the
   * registry; the candidate set then composes with `.where`/`.confidence`/
   * `.history` like any other constraint.
   *
   * Throws {BriQueryError} TOUCHING_NOT_AN_EDGE_COLLECTION when called on a
   * collection that the registry has not registered as an edge collection
   * — `.touching` is meaningless without `from`/`to` field semantics.
   *
   * @param {Array<string|Object>} seeds - Entities or $ID strings
   * @returns {QueryBuilder}
   * @implements UC-G1
   */
  touching(seeds) {
    const ids = (seeds || []).map(s => typeof s === 'string' ? s : (s && s.$ID))
      .filter(Boolean);
    return this._next({ touching: ids });
  }

  /**
   * Resolve named ref fields in one batched round-trip after the result
   * set is built (UC-X1). Each named field is loaded from its target
   * collection via `wrapper.get(null, $ID)` and reattached as a
   * non-enumerable `_<field>` reactive entity on each row. The original
   * field value (the $ID string) is preserved.
   *
   * The hydrate step is a post-execution decoration — it runs AFTER
   * `.toArray()` would have produced its results. Failed hydrations
   * (target doc missing) leave `_<field>` undefined; callers must check.
   *
   * @param {Array<string>} fields - Ref field names to resolve
   * @returns {QueryBuilder}
   * @implements UC-X1
   */
  hydrate(fields) {
    const list = Array.isArray(fields) ? fields.filter(f => typeof f === 'string') : [];
    return this._next({ hydrate: list });
  }

  /**
   * Schema-conditional: filter to docs whose `$confidence` field >= threshold
   * (UC-G1, UC-G2, UC-G6 read-side). Throws BriQueryError on collections
   * that don't declare `$confidence` so a typo doesn't silently drop the
   * filter.
   *
   * @param {number} threshold
   * @returns {QueryBuilder}
   * @throws {BriQueryError} when the collection has no $confidence field
   */
  confidence(threshold) {
    const lc = this._ctx.registry.lifecycleFieldsOf?.(this._ctx.collection);
    if (!lc || !lc.confidence) {
      throw new BriQueryError({
        code: 'CONFIDENCE_FIELD_NOT_DECLARED',
        message: `QueryBuilder.confidence: collection '${this._ctx.collection}' has no $confidence field. Declare $confidence: '<fieldName>' on the schema to enable this filter.`,
        details: { collection: this._ctx.collection }
      });
    }
    return this._next({ confidence: { threshold, field: lc.confidence } });
  }

  /**
   * Schema-conditional getter: include superseded docs (the default read
   * filters them out via `$supersession IS NULL`). Spec §2.2 marks this a
   * property, not a method; using a getter keeps the syntax consistent
   * with `.history` on predicate accessors.
   *
   * Returns a NEW builder rather than mutating; reading `q.history` does
   * not affect `q` itself.
   *
   * @returns {QueryBuilder} new builder with state.history true
   */
  get history() {
    const lc = this._ctx.registry.lifecycleFieldsOf?.(this._ctx.collection);
    if (!lc || !lc.supersession) {
      throw new BriQueryError({
        code: 'SUPERSESSION_FIELD_NOT_DECLARED',
        message: `QueryBuilder.history: collection '${this._ctx.collection}' has no $supersession field. Declare $supersession: '<fieldName>' to enable history reads.`,
        details: { collection: this._ctx.collection }
      });
    }
    return this._next({ history: true });
  }

  /**
   * Schema-conditional getter: hydrate `$provenance` onto each result.
   * Spec §2.10 marks `$provenance` as non-persisted ranking metadata
   * sourced from the schema-declared $provenance field.
   *
   * @returns {QueryBuilder} new builder with state.withProvenance true
   */
  get withProvenance() {
    const lc = this._ctx.registry.lifecycleFieldsOf?.(this._ctx.collection);
    if (!lc || !lc.provenance) {
      throw new BriQueryError({
        code: 'PROVENANCE_FIELD_NOT_DECLARED',
        message: `QueryBuilder.withProvenance: collection '${this._ctx.collection}' has no $provenance field. Declare $provenance: '<fieldName>' to enable.`,
        details: { collection: this._ctx.collection }
      });
    }
    return this._next({ withProvenance: true });
  }

  /**
   * Point-in-time view (spec §2.2 — deferred to v2 per §6.1).
   *
   * v1 throws BriQueryError NOT_IMPLEMENTED_V1 with a clear message so
   * callers see an explicit signal rather than a silent miss-result.
   *
   * @param {Date|number} _t - As-of timestamp
   * @returns {QueryBuilder}
   * @throws {BriQueryError}
   */
  asOf(_t) {
    throw new BriQueryError({
      code: NOT_IMPLEMENTED_V1,
      message: 'QueryBuilder.asOf is deferred to v2 per spec §6.1. v1 only supports current-time views; use .history to include superseded docs.',
      details: {}
    });
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
    const {
      filter, near, match, combine, limit,
      touching, hydrate, confidence, history, withProvenance
    } = this._state;

    // Pass the user's original filter to the planner so it can use the
    // secondary index when the filter shape is index-friendly. Extra
    // schema-conditional gates layer on top of plan.residualFilter
    // AFTER planning — adding them to the input filter would force the
    // planner into a residual-only path and disable index lookups.
    const lc = registry.lifecycleFieldsOf?.(collection) || {};
    const supersedeKey = (lc && lc.supersession) || null;
    const adjacencyIds = touching && touching.length > 0
      ? touchingCandidateIds(this._ctx, touching)
      : null;
    const planner = new QueryPlanner(registry);
    const plan = planner.planWhere(collection, filter);
    // Layer the extra gates on top of any residual filter the planner
    // produced. The combined residual is what the execution paths apply.
    plan.residualFilter = composeResidualFilter({
      planResidual: plan.residualFilter,
      supersedeKey,
      defaultHideSuperseded: !history,
      confidence,
      touching: adjacencyIds
    });
    /**
     * Apply $provenance + ref `_field` hydration after the scan executors finish.
     * @param {Array<Object>} rows - Raw hydrated rows before decoration
     * @returns {Promise<Array<Object>>}
     */
    const applyResultDecoration = (rows) => decorateResults(rows, {
      withProvenance: withProvenance ? lc.provenance : null,
      hydrate, wrapper
    });
    if (combine) {
      if (!match || !near) {
        throw new BriQueryError({
          code: 'COMBINE_PRECONDITIONS_UNMET',
          message: 'QueryBuilder.combine: requires both .match(...) and .near(...) to have been declared earlier in the chain.',
          details: { hasMatch: !!match, hasNear: !!near }
        });
      }
      return applyResultDecoration(
        await this._executeCombinedPlan(plan, match, near, combine, limit)
      );
    }
    if (match && near) {
      throw new BriQueryError({
        code: 'COMBINE_REQUIRED_FOR_HYBRID',
        message: 'QueryBuilder: .match and .near in the same chain require .combine to specify how their scores blend. Add .combine({alias, vector}).',
        details: {}
      });
    }
    if (match) {
      return applyResultDecoration(
        await this._executeMatchPlan(plan, match, limit)
      );
    }
    if (near) {
      return applyResultDecoration(
        await executeVectorPlan(this._ctx, plan, near, limit)
      );
    }
    return applyResultDecoration(await executeWherePlan(this._ctx, plan, limit));
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
   * Convenience terminal: first match or `null` if the result set is empty.
   *
   * @returns {Promise<Object|null>}
   */
  async first() {
    return queryBuilderFirst(this);
  }

  /**
   * Terminal: count of matching docs (UC-X3).
   *
   * @returns {Promise<number>}
   */
  async count() {
    return queryBuilderCount(this);
  }

  /**
   * Terminal: distinct values of `field` across the result set (UC-X3).
   *
   * @param {string} field
   * @returns {Promise<Array>}
   */
  async distinct(field) {
    return queryBuilderDistinct(this, field);
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
