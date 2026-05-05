/**
 * @file Personalized PageRank (UC-G7) — `db.algo.ppr({...})`.
 *
 * Role in the system:
 *   Knowledge-graph retrieval at scale (Ashlyn V8 §3.6.4 retrieval-at-
 *   scale path). Below ~10k triples, 1-hop expansion + brute-rank is
 *   adequate; above that threshold, PPR seeded from entity-link results
 *   is the substrate primitive that delivers query relevance.
 *
 * Algorithm (random walk with restart):
 *   p_next[v] = damping × Σ_{u→v} (w(u,v) / out_strength(u)) × p[u]
 *             + (1 - damping) × seed_dist[v]
 *             + (damping × dangling_mass) × seed_dist[v]
 *   Iterate until max(|p_next - p|) < epsilon, or `iterations` cap.
 *   Damping default 0.85; restart default 0.15. Standard PageRank values.
 *
 * Why log-and-undo / why a CSR-shaped intermediate:
 *   At 50k triples we touch each edge once per iteration. A naive
 *   adjacency walk through the GraphIndex's nested Map<predicate,
 *   Set<edgeId>> structure plus per-edge hydration would dominate the
 *   500ms p95 budget on the inner loop. We pre-flatten the (filtered,
 *   weighted) edges into a CSR-like representation indexed by integer
 *   node IDs and iterate that — typed arrays for the distribution, plain
 *   arrays for the per-source target/weight lists. Pure JS, no
 *   dependencies. Hydration of result nodes happens once at the end.
 *
 * Consumed by: engine/graph-algo.js (createAlgo wires `ppr` into the
 *   db.algo namespace).
 * Consumes: schema-registry (edgeSpec for from/to field names),
 *   filter-compiler when an edgeFilter is supplied.
 *
 * @implements UC-G7 (Personalized PageRank)
 */

import { compileFilter } from './filter-compiler.js';

/**
 * Run PPR over a registered edge collection seeded from a node set.
 *
 * Validation of arguments fires up front so callers fail fast on misuse;
 * subsequent steps assume `collection`, `via`, and `seeds` are present.
 *
 * @param {Object} args
 * @param {string} args.collection - Node collection (e.g. 'kgEntity')
 * @param {string} args.via - Edge collection (e.g. 'kgTriple')
 * @param {Array<Object|string>} args.seeds - Entities or $ID strings to
 *   seed the personalized distribution. Seeds outside `collection` are
 *   silently dropped (no-throw — caller may pass a mixed list).
 * @param {number} [args.damping=0.85] - Random-walk continuation prob.
 *   `1 - damping` is the restart probability that re-injects mass into
 *   the seed distribution every step.
 * @param {number} [args.iterations=50] - Hard cap on power-iteration
 *   passes. Convergence usually completes in 20–40 iterations at
 *   damping 0.85; the cap protects pathological inputs.
 * @param {number} [args.epsilon=1e-6] - Convergence threshold on
 *   `max(|p_next[v] - p[v]|)`. Loop exits early when reached.
 * @param {number} [args.top] - Cap result count (top-k by mass).
 * @param {Object|Function} [args.edgeFilter] - Filter applied per edge
 *   (e.g. `{superseded_by_id: null}`). Compiled via filter-compiler so
 *   $ne / $gte / $exists / etc. all work. Edges that fail the filter
 *   are dropped from the walk graph entirely (NOT post-filtered).
 * @param {string} [args.weightField] - Edge field whose numeric value
 *   weights the transition probability. Missing / non-numeric → falls
 *   back to weight 1 for that edge.
 * @param {Object} args.registry - Schema registry (provided by createAlgo)
 * @param {Function} args.getDb - Lazy db accessor (provided by createAlgo)
 * @returns {Promise<Array<{entity:Object, mass:number}>>} top-k nodes
 *   ranked by stationary mass, each with its hydrated entity.
 * @throws {Error} on missing required args
 */
export async function ppr({
  collection, via, seeds, damping, iterations, epsilon, top,
  edgeFilter, weightField, registry, getDb
}) {
  if (!collection || !via || !seeds) {
    throw new Error(
      'db.algo.ppr: requires { collection, via, seeds }. ' +
      'Optional: damping (default 0.85), iterations (default 50), ' +
      'epsilon (default 1e-6), top, edgeFilter, weightField.'
    );
  }
  const damp = typeof damping === 'number' ? damping : 0.85;
  const restart = 1 - damp;
  const maxIter = typeof iterations === 'number' ? iterations : 50;
  const eps = typeof epsilon === 'number' ? epsilon : 1e-6;

  const db = getDb();
  const edgeSpec = registry.edgeSpec(via);
  if (!edgeSpec) {
    throw new Error(`db.algo.ppr: '${via}' is not a registered edge collection`);
  }
  // Compile edgeFilter once — function form passes through; object form
  // is compiled via the shared filter-compiler so operators stay
  // consistent with `.where`.
  const filterFn = !edgeFilter ? null
                 : (typeof edgeFilter === 'function' ? edgeFilter : compileFilter(edgeFilter));

  // 1. Materialize node + edge data. db.get[$collectionS]() returns
  //    reactive entities post-hydration; we need stable $ID + body.
  const nodes = await db.get[`${collection}S`]();
  const edges = await db.get[`${via}S`]();

  // 2. Build node $ID → integer index map (and inverse for result hydration).
  const idxOfId = new Map();
  const idToEntity = [];
  for (const n of nodes) {
    if (!n || !n.$ID) continue;
    idxOfId.set(n.$ID, idxOfId.size);
    idToEntity.push(n);
  }
  const N = idToEntity.length;
  if (N === 0) return [];

  // 3. CSR-like adjacency: per-source target+weight arrays + sumWeight.
  const adj = new Array(N);
  for (let i = 0; i < N; i++) adj[i] = { targets: [], weights: [], sumWeight: 0 };
  const symmetric = !!edgeSpec.symmetric;
  for (const edge of edges) {
    if (!edge || !edge.$ID) continue;
    if (filterFn && !filterFn(edge)) continue;
    const fromVal = edge[edgeSpec.from];
    const toVal = edge[edgeSpec.to];
    const fromId = typeof fromVal === 'string' ? fromVal : (fromVal && fromVal.$ID);
    const toId = typeof toVal === 'string' ? toVal : (toVal && toVal.$ID);
    const fromIdx = idxOfId.get(fromId);
    const toIdx = idxOfId.get(toId);
    if (fromIdx === undefined || toIdx === undefined) continue;
    const w = (weightField && typeof edge[weightField] === 'number' && edge[weightField] > 0)
            ? edge[weightField] : 1;
    adj[fromIdx].targets.push(toIdx);
    adj[fromIdx].weights.push(w);
    adj[fromIdx].sumWeight += w;
    if (symmetric) {
      adj[toIdx].targets.push(fromIdx);
      adj[toIdx].weights.push(w);
      adj[toIdx].sumWeight += w;
    }
  }

  // 4. Seed distribution (uniform over valid seeds; in-collection only).
  const seedDist = new Float64Array(N);
  let validSeeds = 0;
  for (const s of seeds) {
    const id = typeof s === 'string' ? s : (s && s.$ID);
    const idx = id ? idxOfId.get(id) : undefined;
    if (idx === undefined) continue;
    seedDist[idx] = 1;
    validSeeds++;
  }
  if (validSeeds === 0) return [];
  for (let i = 0; i < N; i++) seedDist[i] /= validSeeds;

  // 5. Power iteration. Start from the seed distribution (warm start).
  let p = new Float64Array(seedDist);
  let pNext = new Float64Array(N);
  for (let iter = 0; iter < maxIter; iter++) {
    pNext.fill(0);
    let danglingMass = 0;
    for (let u = 0; u < N; u++) {
      const a = adj[u];
      if (a.sumWeight === 0) {
        // Dangling node: redistribute its mass to the seed dist
        // (standard PageRank correction; without it, mass leaks).
        danglingMass += p[u];
        continue;
      }
      const factor = damp * p[u] / a.sumWeight;
      const T = a.targets, W = a.weights;
      for (let j = 0; j < T.length; j++) pNext[T[j]] += factor * W[j];
    }
    const restartMass = restart + damp * danglingMass;
    for (let i = 0; i < N; i++) pNext[i] += restartMass * seedDist[i];

    // Convergence check.
    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      const d = pNext[i] - p[i];
      const a = d < 0 ? -d : d;
      if (a > maxDelta) maxDelta = a;
    }
    [p, pNext] = [pNext, p];
    if (maxDelta < eps) break;
  }

  // 6. Top-k by mass. Walk the distribution once.
  const ranked = [];
  for (let i = 0; i < N; i++) {
    if (p[i] > 0) ranked.push({ idx: i, mass: p[i] });
  }
  ranked.sort((a, b) => b.mass - a.mass);
  const sliced = typeof top === 'number' ? ranked.slice(0, top) : ranked;

  // 7. Hydrate result rows. idToEntity is the pre-built inverse map so
  //    this is O(top), not O(N²).
  const out = [];
  for (const { idx, mass } of sliced) out.push({ entity: idToEntity[idx], mass });
  return out;
}

export default ppr;
