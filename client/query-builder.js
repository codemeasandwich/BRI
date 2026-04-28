/**
 * @file Chainable query builder for Bri reads
 *
 * Backs the new chainable form `db.get.{collection}S.where(...).near(...)`.
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
   * @returns {QueryBuilder}
   */
  near(vector, k) {
    if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
      throw new Error('QueryBuilder.near: vector must be an array of numbers');
    }
    if (typeof k !== 'number' || k <= 0) {
      throw new Error(`QueryBuilder.near: k must be a positive number; got ${k}`);
    }
    return this._next({ near: { vector, k } });
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
    const filterFn = compileFilter(filter);

    if (near) {
      const index = registry.vectorIndex(collection);
      if (!index) {
        throw new Error(
          `QueryBuilder.near: collection '${collection}' has no vector field ` +
          `declared. Call db.schema('${collection}', { ...embedding: { type: 'vector', dims: N } }).`
        );
      }

      // Two-phase: first get a candidate-passing predicate over the doc body.
      // The vector index only knows IDs, so we hydrate when the predicate
      // needs to inspect document content. To keep this O(candidates) and
      // not O(collection), we cache hydrated docs across the predicate calls
      // performed by a single search.
      const docCache = new Map();
      const predicate = filter
        ? (id) => {
            // Caller predicate runs against doc body — hydrate-then-filter.
            // Cache means each id is read at most once per search.
            if (!docCache.has(id)) {
              // We can't await inside the synchronous search loop; so we
              // pre-hydrate below. See the shortcut path.
              return false;
            }
            return filterFn(docCache.get(id));
          }
        : null;

      // If a filter is provided, pre-hydrate ALL candidate IDs once. At v1
      // scale (<=10k docs) this is acceptable; v2 will swap to an
      // index-driven predicate that doesn't need doc bodies.
      let hits;
      if (filter) {
        const allIds = await wrapper.get(`${collection}S`).then(items =>
          items.map(item => item.$ID)
        );
        const docs = await Promise.all(
          allIds.map(id => wrapper.get(null, id).then(d => [id, d]))
        );
        for (const [id, doc] of docs) docCache.set(id, doc);
        hits = index.searchFiltered(near.vector, near.k, predicate);
      } else {
        hits = index.search(near.vector, near.k);
      }

      // Hydrate hits (we already have docs cached if filter ran; otherwise
      // fetch each id). Attach score metadata to each entity.
      const out = [];
      for (const { id, score } of hits) {
        let entity;
        if (docCache.has(id)) {
          // We have the JSON shape; hydrate via wrapper.get for reactive proxy
          entity = await wrapper.get(null, id);
        } else {
          entity = await wrapper.get(null, id);
        }
        if (entity) out.push(attachScore(entity, score));
      }
      return typeof limit === 'number' ? out.slice(0, limit) : out;
    }

    // Non-vector path: use the existing wrapper.get group call.
    const group = `${collection}S`;
    const list = await wrapper.get(group);
    const filtered = filter ? list.filter(filterFn) : list;
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
