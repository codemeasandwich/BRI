/**
 * @file Canonical-pair index helpers (UC-G3).
 *
 * Extracted from schema-registry.js to keep that file under the 260-NCLOC
 * pre-commit gate. The schema registry holds the membership Set
 * (`canonicalPairCollections`) and forwards the two helpers exposed here
 * to consumers (vector-middleware, QueryBuilder.between, the migration
 * helper in graph-algo.js).
 *
 * Why a separate module rather than inline in schema-registry.js:
 *   The registry is the single source of truth for cross-cutting state.
 *   Pure helper functions that operate on registry state but don't own
 *   any of it belong outside the closure — testable in isolation,
 *   reusable from both the registry and the migration path.
 *
 * Consumed by: schema-registry.js (delegates needsCanonicalPair /
 *   canonicalPairKey), engine/graph-algo.js (rebuildCanonicalPair uses
 *   canonicalPairKey directly to avoid a registry round-trip per edge).
 * Consumes: nothing — pure utilities.
 *
 * @implements UC-G3 (canonical-pair lookup + uniqueness substrate)
 */

/**
 * Compute the canonical-pair key for an edge document — the lex-sorted
 * `[min(fromId, toId), max(fromId, toId)]` two-element array, or null
 * when the doc is missing one of the endpoint fields (treat as "no pair
 * to index"; middleware no-ops; query never matches).
 *
 * Why total-order over the raw $ID strings:
 *   $IDs are lexicographically comparable strings (engine/id.js); JS
 *   string compare is total and deterministic. We do NOT canonicalize by
 *   collection or strip prefixes — the pair {alpha, beta} would never
 *   legally span two collections under a single `$edge` declaration, and
 *   preserving raw strings keeps the key trivially reversible for
 *   debugging.
 *
 * Symmetry invariant:
 *   `canonicalPairKey(spec, {from: A, to: B})` ===
 *   `canonicalPairKey(spec, {from: B, to: A})`. Required for the
 *   uniqueness invariant to hold under either insert direction.
 *
 * @param {Object} edgeSpec - Enriched edge spec from buildEdgeSpec
 *   (must have `from` and `to` field-name strings)
 * @param {Object} doc - Edge document (must carry the from/to fields)
 * @returns {Array<string>|null} `[lo, hi]` two-element pair or null
 */
export function canonicalPairKeyFor(edgeSpec, doc) {
  if (!edgeSpec || !doc) return null;
  const fromId = doc[edgeSpec.from];
  const toId = doc[edgeSpec.to];
  if (!fromId || !toId) return null;
  return fromId < toId ? [fromId, toId] : [toId, fromId];
}

export default canonicalPairKeyFor;
