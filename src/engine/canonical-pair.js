/**
 * @file Canonical-pair index helpers (UC-G3) + persistent-graph
 * bootstrap helpers (UC-G7 / Persistent GraphIndex).
 *
 * Extracted from schema-registry.js to keep that file under the 260-NCLOC
 * pre-commit gate. The schema registry retains the membership Set
 * (`canonicalPairCollections`) and forwards both groups of helpers
 * exposed here to consumers (vector-middleware, QueryBuilder.between,
 * the migration helper in graph-algo.js).
 *
 * Why a separate module rather than inline in schema-registry.js:
 *   The registry is the single source of truth for cross-cutting state.
 *   Pure helper functions that operate on registry state but don't own
 *   any of it belong outside the closure — testable in isolation,
 *   reusable from both the registry and the migration path.
 *
 * Consumed by: schema-registry.js (delegates needsCanonicalPair /
 *   canonicalPairKey + bindGraphIndexToStore / rebuildAdjacencyFromHot),
 *   engine/graph-algo.js (rebuildCanonicalPair uses canonicalPairKey
 *   directly to avoid a registry round-trip per edge).
 * Consumes: nothing — pure utilities. Storage and GraphIndex shapes
 *   are passed in as opaque arguments.
 *
 * @implements UC-G3 (canonical-pair lookup + uniqueness substrate),
 *             UC-G7 (Persistent GraphIndex bootstrap)
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

/**
 * UC-G7 / Persistent GraphIndex — bootstrap a freshly-constructed
 * GraphIndex from the snapshot's pre-loaded state and bind the live
 * reference back to the store. No-ops gracefully when the store does
 * not implement the persistence hooks (older / minimal storage adapters).
 *
 * @param {Object|null|undefined} store - Storage adapter (may lack hooks)
 * @param {Object} graphIndex - GraphIndex instance to bootstrap
 * @returns {void}
 */
export function bindGraphIndexToStore(store, graphIndex) {
  if (!store) return;
  const pendingGraph = store.getPendingGraphState?.();
  if (pendingGraph) graphIndex.load(pendingGraph);
  store.bindGraphIndex?.(graphIndex);
}

/**
 * UC-G7 / Persistent GraphIndex — auto-rebuild a single edge collection's
 * adjacency from hot-tier docs when no persisted state was loaded for it
 * (v3→v4 migration / fresh DB / store without persistence hooks). The
 * rebuild walks every doc in the collection's hot-tier set and feeds it
 * to `graphIndex.insertEdge`, which is idempotent — safe to call again
 * if the rebuild's first pass produced partial coverage.
 *
 * Cold-tier docs are skipped (sync iteration cannot await the cold
 * loader). The next snapshot trigger emits v4 with the rebuilt
 * adjacency, after which subsequent boots have full coverage from the
 * snapshot directly.
 *
 * @param {Object|null|undefined} store - Storage adapter
 * @param {Object} graphIndex - GraphIndex instance
 * @param {string} collection - Edge collection name
 * @param {string} prefix - 4-char $ID prefix (uppercase) for the collection
 * @returns {number} count of edge docs scanned + inserted
 */
export function rebuildAdjacencyFromHot(store, graphIndex, collection, prefix) {
  if (!store?.iterateHotDocsByPrefix) return 0;
  let n = 0;
  for (const doc of store.iterateHotDocsByPrefix(prefix)) {
    graphIndex.insertEdge(collection, doc);
    n++;
  }
  return n;
}

export default canonicalPairKeyFor;
