/**
 * @file Graph algorithms — `db.algo.{name}` per spec §2.7.
 *
 * v1 implements `degree` (centrality) only. PPR (`db.algo.ppr`) is scoped
 * for v3 per spec §6.3 / §7.5.
 *
 * Why a free namespace: parameter-rich algorithms read better as
 * `db.algo.degree({collection, via, weighted, top})` than as a property
 * access on an entity proxy. The proxy is for ergonomic per-entity reads;
 * algorithms that operate over an entire collection / edge set belong in
 * a separate, deliberate namespace.
 *
 * @implements UC-G5 (degree)
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
    degree: (args) => degree({ ...args, registry, getDb })
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

export default createAlgo;
