/**
 * @file Substring-FTS scan + weighted-blend execution helpers for the
 * query builder. Backs the `.match()` (UC-X4) and `.combine()` (UC-V3)
 * chain methods.
 *
 * Why a sibling module (not methods on QueryBuilder):
 *   1. Keeps client/query-builder.js under the 260-source-line gate the
 *      pre-commit hook enforces — match + combine together would push it
 *      over otherwise.
 *   2. Both helpers are pure functions over (plan, clause, ctx) and have
 *      no chain-state of their own; the QueryBuilder just dispatches to
 *      them. That makes them testable in isolation when v2 needs more
 *      sophisticated scoring (TF-IDF, fuzzy match, etc.) without the
 *      QueryBuilder's chain ergonomics getting in the way.
 *
 * Relationship to the rest of the system:
 *   - Consumes the QueryPlanner's `{useIndex, candidateIds, residualFilter}`
 *     plan so .where prefilter applies the same way as in pure .where /
 *     .near paths.
 *   - Consumes the schema registry's VectorIndex via the wrapper for the
 *     combined path's cosine scoring.
 *   - Returns hydrated reactive entities (via wrapper.get) with non-
 *     enumerable metadata fields ($score, $cosine, $matchHits) so callers
 *     can audit the ranking decision per UC-V3's audit_trail criterion.
 *
 * Why binary match scoring (v1):
 *   Spec §6.1: "FTS §2.10 — basic substring match only; no stemming /
 *   stopwords." A binary {0, 1} score keeps the v1 surface predictable;
 *   recency (updatedAt) is the documented tiebreak per UC-X4. v2 will
 *   replace the score with TF-IDF or BM25 once the persistent FTS index
 *   lands.
 *
 * @implements UC-X4 (match), UC-V3 (combine)
 */

/**
 * Substring containment test for a single field. Strings match if the
 * candidate's value (lowercased) contains the query (lowercased). Arrays
 * match if any element (string-coerced + lowercased) contains the query.
 * Other shapes don't match — undefined / null / number / boolean fields
 * are treated as misses.
 *
 * Why case-insensitive: alias and content fields are typically authored
 * with mixed case; UC-X4 doesn't specify case sensitivity, so the
 * universally-friendlier default is case-fold compare.
 *
 * @param {*} value - Field value from the candidate doc
 * @param {string} query - Lowercased query string
 * @returns {boolean}
 */
function fieldContains(value, query) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.toLowerCase().includes(query);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.toLowerCase().includes(query)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Score a single document against the match clause. Returns a hit record
 * (with the matched field name + the original query value) if any of the
 * clause's fields contains the query; null if no field matches.
 *
 * The first matching field wins for $matchHits attribution — keeps the
 * audit trail compact even when multiple aliases would match.
 *
 * @param {Object} doc - Candidate document
 * @param {Object} matchFilter - {field: substring, ...}
 * @returns {{field:string, value:string}|null}
 */
function scoreMatch(doc, matchFilter) {
  for (const [field, query] of Object.entries(matchFilter)) {
    if (typeof query !== 'string') continue;
    const lcQuery = query.toLowerCase();
    if (fieldContains(doc[field], lcQuery)) {
      return { field, value: query };
    }
  }
  return null;
}

/**
 * Sort comparator: primary by score desc, tiebreak by updatedAt desc
 * (newer first). updatedAt is a Date; .getTime() is numeric.
 *
 * @param {Object} a - Scored entry; shape {score, doc, ...}
 * @param {Object} b - Scored entry; shape {score, doc, ...}
 * @returns {number}
 */
function rankCompare(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.doc && a.doc.updatedAt ? new Date(a.doc.updatedAt).getTime() : 0;
  const bt = b.doc && b.doc.updatedAt ? new Date(b.doc.updatedAt).getTime() : 0;
  return bt - at;
}

/**
 * Attach search-result metadata as non-enumerable properties so toObject /
 * JSON-serialization paths stay clean. Mirrors the convention used by the
 * vector path's attachScore helper in query-builder.js.
 *
 * @param {Object} entity
 * @param {Object} meta - {score?, cosine?, matchHits?}
 * @returns {Object} the same entity reference
 */
function attachMeta(entity, meta) {
  if (!entity) return entity;
  if (typeof meta.score === 'number') {
    Object.defineProperty(entity, '$score', {
      value: meta.score, enumerable: false, configurable: true, writable: false
    });
  }
  if (typeof meta.cosine === 'number') {
    Object.defineProperty(entity, '$cosine', {
      value: meta.cosine, enumerable: false, configurable: true, writable: false
    });
  }
  if (meta.matchHits) {
    Object.defineProperty(entity, '$matchHits', {
      value: meta.matchHits, enumerable: false, configurable: true, writable: false
    });
  }
  return entity;
}

/**
 * Hydrate a candidate set: starts from the QueryPlanner's plan (index
 * candidates if available, else full collection) then applies the residual
 * filter. Result is the array of doc bodies (reactive entities) the match
 * scan walks over.
 *
 * @param {Object} plan - From QueryPlanner.planWhere
 * @param {string} collection
 * @param {Object} wrapper
 * @returns {Promise<Array<Object>>}
 */
async function hydrateCandidates(plan, collection, wrapper) {
  if (plan.useIndex) {
    const ids = [...plan.candidateIds];
    const docs = await Promise.all(ids.map(id => wrapper.get(null, id)));
    return plan.residualFilter
      ? docs.filter(d => d && plan.residualFilter(d))
      : docs.filter(Boolean);
  }
  const all = await wrapper.get(`${collection}S`);
  return plan.residualFilter ? all.filter(plan.residualFilter) : all;
}

/**
 * Execute a `.match` (no `.near`) read.
 *
 * Pipeline:
 *   1. Hydrate candidates per the .where plan.
 *   2. Score each candidate via scoreMatch — binary {0, 1} per spec §6.1.
 *   3. Filter to score=1 (matched), drop the rest.
 *   4. Sort by (score desc, updatedAt desc) — UC-X4 recency tiebreak.
 *   5. Apply k cap (from .match's k arg or .limit, whichever is smaller).
 *   6. Attach $matchHits to each surviving result.
 *
 * @param {Object} args
 * @param {Object} args.plan - From QueryPlanner.planWhere
 * @param {Object} args.match - {filter, k}
 * @param {number|undefined} args.limit
 * @param {string} args.collection
 * @param {Object} args.wrapper
 * @returns {Promise<Array<Object>>}
 */
export async function executeMatch({ plan, match, limit, collection, wrapper }) {
  const candidates = await hydrateCandidates(plan, collection, wrapper);
  const scored = [];
  for (const doc of candidates) {
    if (!doc) continue;
    const hits = scoreMatch(doc, match.filter);
    if (hits) scored.push({ doc, score: 1, matchHits: hits });
  }
  scored.sort(rankCompare);
  const cap = capFromOptions(match.k, limit);
  const top = typeof cap === 'number' ? scored.slice(0, cap) : scored;
  return top.map(s => attachMeta(s.doc, { matchHits: s.matchHits }));
}

/**
 * Execute a combined .match + .near + .combine read.
 *
 * Pipeline:
 *   1. Hydrate candidates per the .where plan (this becomes the universe).
 *   2. Compute matchScore (0/1) + matchHits per candidate via scoreMatch.
 *   3. Compute cosine via the VectorIndex for candidates with embeddings.
 *      (Cosine for missing/wrong-shape embeddings is treated as 0 so a
 *      doc with no embedding still ranks via alias alone — UC-V3
 *      null_embedding_eligible_via_alias.)
 *   4. blendedScore = weights.alias * matchScore + weights.vector * cosine.
 *   5. Drop docs whose blendedScore is 0 — neither component contributed.
 *   6. Sort by blendedScore desc (no recency tiebreak — vector cosine has
 *      enough numeric resolution to break ties without needing updatedAt).
 *   7. Apply cap (limit or near.k).
 *   8. Attach $score, $cosine, $matchHits per UC-V3's audit_trail criterion.
 *
 * @param {Object} args
 * @param {Object} args.plan
 * @param {Object} args.match
 * @param {Object} args.near
 * @param {Object} args.weights
 * @param {number|undefined} args.limit
 * @param {string} args.collection
 * @param {Object} args.registry
 * @param {Object} args.wrapper
 * @returns {Promise<Array<Object>>}
 */
export async function executeCombined({ plan, match, near, weights, limit, collection, registry, wrapper }) {
  const index = registry.vectorIndex(collection);
  if (!index) {
    throw new Error(
      `QueryBuilder.combine: collection '${collection}' has no vector field; ` +
      `.combine requires the same vector field .near is searching against.`
    );
  }
  const candidates = await hydrateCandidates(plan, collection, wrapper);

  // Score each candidate on both axes. Cosine via the VectorIndex's exact
  // search rather than the doc's embedding directly so the math agrees
  // exactly with what .near alone would have produced.
  const cosineById = new Map();
  // searchFiltered with a candidate-set predicate gives us {id, score} for
  // every candidate that has an indexed embedding. Phantoms / no-embedding
  // docs simply won't appear in the result; we treat them as cosine=0.
  const candidateIds = new Set(candidates.filter(Boolean).map(d => d.$ID));
  if (candidateIds.size > 0) {
    const hits = index.searchFiltered(near.vector, candidateIds.size,
      (id) => candidateIds.has(id));
    for (const h of hits) cosineById.set(h.id, h.score);
  }

  const scored = [];
  for (const doc of candidates) {
    if (!doc) continue;
    const matchHits = scoreMatch(doc, match.filter);
    const matchScore = matchHits ? 1 : 0;
    const cosine = cosineById.get(doc.$ID) || 0;
    const blended = weights.alias * matchScore + weights.vector * cosine;
    if (blended === 0) continue;  // neither component contributed
    scored.push({ doc, score: blended, cosine, matchHits });
  }
  scored.sort(rankCompare);
  const cap = capFromOptions(near.k, limit);
  const top = typeof cap === 'number' ? scored.slice(0, cap) : scored;
  return top.map(s => attachMeta(s.doc, {
    score: s.score, cosine: s.cosine, matchHits: s.matchHits
  }));
}

/**
 * Resolve the effective top-k cap from user options. Both `.match(filter, k)`
 * and `.limit(n)` can supply a cap; we take the smaller of the two when
 * both are present.
 *
 * @param {number|undefined} kFromClause
 * @param {number|undefined} kFromLimit
 * @returns {number|undefined}
 */
function capFromOptions(kFromClause, kFromLimit) {
  if (typeof kFromClause === 'number' && typeof kFromLimit === 'number') {
    return Math.min(kFromClause, kFromLimit);
  }
  return typeof kFromClause === 'number' ? kFromClause : kFromLimit;
}
