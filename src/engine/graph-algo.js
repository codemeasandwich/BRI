/**
 * @file Graph algorithms — `db.algo.{name}` per spec §2.7.
 *
 * Today implements `degree` (UC-G5) and `rebuildCanonicalPair` (UC-G3
 * migration). PPR (`db.algo.ppr`) remains scoped for v3 per spec §6.3 /
 * §7.5; out of scope for the UC-G3 round.
 *
 * Why a free namespace: parameter-rich algorithms read better as
 * `db.algo.degree({collection, via, weighted, top})` than as a property
 * access on an entity proxy. The proxy is for ergonomic per-entity reads;
 * algorithms that operate over an entire collection / edge set belong in
 * a separate, deliberate namespace.
 *
 * Consumed by: client/index.js (db.algo wiring).
 * Consumes: schema-registry (graphIndex, edgeSpec, secondaryIndexManager,
 *   needsCanonicalPair, canonicalPairKey), getDb for hydration through
 *   db.get[`${collection}S`]() — kept lazy so the registry can be built
 *   before the db singleton resolves.
 *
 * @implements UC-G5 (degree), UC-G3 migration (rebuildCanonicalPair)
 */

/**
 * Build the db.algo namespace for a public db interface.
 *
 * @param {Object} ctx
 * @param {Object} ctx.registry - Schema registry (for graphIndex, edge specs)
 * @param {Function} ctx.getDb - Lazy db accessor (for hydration through db.get)
 * @returns {Object} algo namespace with `degree` (and future PPR, etc.)
 */
export function createAlgo({ registry, getDb }) {
  return {
    /**
     * Degree centrality — for every node in `collection`, sum incoming +
     * outgoing edges in the edge collection `via`. Optionally weighted by
     * a numeric edge attribute. Returns nodes sorted by degree desc.
     *
     * @param {Object} args
     * @param {string} args.collection - Node collection (e.g. 'kgEntity')
     * @param {string} args.via - Edge collection (e.g. 'kgTriple')
     * @param {string} [args.weighted] - Edge field whose numeric value is
     *   summed instead of edge count; missing/non-numeric values count 0
     * @param {number} [args.top] - Cap result count (top-k)
     * @returns {Promise<Array<{entity:Object, degree:number}>>}
     */
    degree: (args) => degree({ ...args, registry, getDb }),

    /**
     * UC-G3 migration helper — rebuild the canonical-pair secondary index
     * for an edge collection from existing edge documents.
     *
     * When to call: only ONCE, after upgrading from a Bri version that
     * predates `$edge.unique && symmetric` enforcement (≤ v2.0.0) and
     * still has edge documents on disk. The canonical-pair index is
     * normally populated by vector-middleware on every add/set, so fresh
     * databases never need this. The rebuild is idempotent — if the
     * index is already populated it re-inserts the same keys.
     *
     * Why expose it here vs. running automatically at registry construction:
     *   The registry's declare() is synchronous; the rebuild requires
     *   async iteration of the store via `db.get[`${collection}S`]()`,
     *   which depends on the db singleton being fully wired (middleware
     *   chain, proxy traps, etc.). Making declare() async would ripple
     *   through every consumer; an explicit one-shot call keeps the cost
     *   visible.
     *
     * @param {Object} args
     * @param {string} args.collection - Edge collection name (must be
     *   declared with `$edge.unique && $edge.symmetric` — throws otherwise
     *   so misuse on a non-canonical-pair collection fails loudly).
     * @returns {Promise<{collection:string, indexed:number}>} count of
     *   edges successfully indexed; useful as a smoke check after an
     *   upgrade that the index is populated.
     */
    rebuildCanonicalPair: (args) => rebuildCanonicalPair({ ...args, registry, getDb })
  };
}

/**
 * Compute degree centrality for every node in a collection.
 *
 * Strategy:
 *   1. Fetch every node $ID in the collection (one group-get).
 *   2. For each node, ask the GraphIndex for outgoing + incoming edge
 *      lists in O(degree).
 *   3. If weighted, hydrate each edge once per appearance and sum the
 *      named field; otherwise just count.
 *   4. Sort by degree desc, slice to `top`, hydrate the surviving nodes.
 *
 * Edge hydration is cached so an edge that appears in both directions
 * (a→b counted on both a's outgoing and b's incoming) reads at most once.
 *
 * Phantom adjacency entries (edge id present in adjacency but doc missing)
 * are skipped silently per spec resilience criterion (UC-G5: dangling
 * ref does not crash).
 *
 * @param {Object} args
 * @param {string} args.collection
 * @param {string} args.via
 * @param {string} [args.weighted]
 * @param {number} [args.top]
 * @param {Object} args.registry
 * @param {Function} args.getDb
 * @returns {Promise<Array<{entity:Object, degree:number}>>}
 */
async function degree({ collection, via, weighted, top, registry, getDb }) {
  if (!collection || !via) {
    throw new Error('db.algo.degree: requires { collection, via }');
  }
  const graphIndex = registry.graphIndex();
  const edgeSpec = registry.edgeSpec(via);
  if (!edgeSpec) {
    throw new Error(`db.algo.degree: '${via}' is not a registered edge collection`);
  }
  const db = getDb();
  // Enumerate all node $IDs in the collection. Uses the legacy callable
  // form so opts handling is consistent with other algo entry points.
  const allNodes = await db.get[`${collection}S`]();
  const ids = allNodes.filter(Boolean).map(n => n.$ID);

  // Edge cache so a single edge counted on both sides hydrates once.
  const edgeCache = new Map();
  /**
   * Lazy edge hydrator — returns the edge doc or null on phantom miss.
   * @param {string} edgeId
   * @returns {Promise<Object|null>}
   */
  const fetchEdge = async (edgeId) => {
    if (edgeCache.has(edgeId)) return edgeCache.get(edgeId);
    const doc = await db.get[via](edgeId).catch(() => null);
    edgeCache.set(edgeId, doc || null);
    return doc || null;
  };

  const scores = [];
  for (const nodeId of ids) {
    const edgeIds = [
      ...graphIndex.outgoing(nodeId, via),
      ...graphIndex.incoming(nodeId, via)
    ];
    let score = 0;
    if (weighted) {
      for (const edgeId of edgeIds) {
        const edge = await fetchEdge(edgeId);
        if (!edge) continue;
        const v = edge[weighted];
        if (typeof v === 'number') score += v;
      }
    } else {
      // Unweighted: each edge id contributes 1 — but we still need to
      // skip phantoms to honor the resilience contract.
      for (const edgeId of edgeIds) {
        const edge = await fetchEdge(edgeId);
        if (edge) score += 1;
      }
    }
    scores.push({ nodeId, degree: score });
  }
  scores.sort((a, b) => b.degree - a.degree);
  const sliced = typeof top === 'number' ? scores.slice(0, top) : scores;
  // Map nodeId -> entity for the survivors (one fetch each).
  const out = [];
  for (const { nodeId, degree: d } of sliced) {
    const entity = await db.get[collection](nodeId).catch(() => null);
    if (entity) out.push({ entity, degree: d });
  }
  return out;
}

/**
 * Implementation: UC-G3 canonical-pair index rebuild.
 *
 * Iterates every edge document in `collection` and inserts a shadow
 * `__edgePair` projection into the SecondaryIndexManager — same shape
 * the live `vector-middleware.js` uses on add/set, so the index ends up
 * identical to one populated incrementally.
 *
 * Why this is safe to run on a populated index:
 *   `SortedIndex.insert(key, id)` is idempotent on `(key, id)` pairs.
 *   Re-inserting an already-indexed edge is a no-op.
 *
 * Why we read via `db.get[`${collection}S`]()` rather than the raw store:
 *   Goes through the same hydration path as production reads, so any
 *   reactive-proxy or schema transform applies uniformly. Identical to
 *   `degree`'s iteration pattern at line 82 — see file docblock.
 *
 * Phantom safety: if a doc is missing `from`/`to` fields,
 * `canonicalPairKey` returns null and we skip the insert (would have
 * been impossible to index in the live path either).
 *
 * @param {Object} args
 * @param {string} args.collection - Edge collection name
 * @param {Object} args.registry   - Schema registry
 * @param {Function} args.getDb    - Lazy db accessor
 * @returns {Promise<{collection:string, indexed:number}>}
 * @throws {Error} when collection is not declared as $edge.unique && symmetric
 */
async function rebuildCanonicalPair({ collection, registry, getDb }) {
  if (!collection) {
    throw new Error('db.algo.rebuildCanonicalPair: requires { collection }');
  }
  if (!registry.needsCanonicalPair(collection)) {
    throw new Error(
      `db.algo.rebuildCanonicalPair: '${collection}' is not declared as a ` +
      `unique-symmetric edge collection ($edge.unique && $edge.symmetric). ` +
      `Either declare both flags on the schema, or skip the rebuild — ` +
      `non-canonical-pair collections have nothing to rebuild.`
    );
  }
  const idxMgr = registry.secondaryIndexManager();
  const db = getDb();
  // Enumerate all edges in the collection. Same `${collection}S` shape
  // as `degree` uses; the trailing 'S' triggers the legacy callable-form
  // group-get (returns Array<entity>).
  const edges = await db.get[`${collection}S`]();
  let indexed = 0;
  for (const edge of edges) {
    if (!edge || !edge.$ID) continue;
    const pairKey = registry.canonicalPairKey(collection, edge);
    if (!pairKey) continue;
    // Mirror the live shadow-doc pattern from vector-middleware.js: a
    // plain POJO with `__edgePair` projected; the persisted body is
    // never mutated.
    const shadow = typeof edge.toObject === 'function' ? edge.toObject() : { ...edge };
    shadow.__edgePair = pairKey;
    idxMgr.insert(collection, shadow);
    indexed++;
  }
  return { collection, indexed };
}

export default createAlgo;
