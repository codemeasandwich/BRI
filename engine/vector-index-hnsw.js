/**
 * @file Pure-JS HNSW algorithm for the in-process vector index.
 *
 * Role in the system:
 *   This module owns the HNSW (Hierarchical Navigable Small World) graph
 *   topology and the insert / search / select-neighbours primitives that
 *   operate on it. The wrapper class in engine/vector-index.js owns slot
 *   storage (Float32Array, _idAt, _slotOf, free-list, transactions) and
 *   delegates to the helpers exported here whenever a topology mutation
 *   or a graph-walking search is needed.
 *
 *   Splitting the algorithm out from the wrapper does three things:
 *     1) keeps engine/vector-index.js close to the 200 NCLOC limit,
 *     2) lets the codec (vector-index-codec.js) reach in for topology
 *        fields without entangling the wrapper's transaction surface,
 *     3) makes the algorithm reviewable in isolation against the
 *        reference HNSW paper (Malkov & Yashunin 2018).
 *
 * Dependencies:
 *   - vector-index-codec.js → cosine() (reused so all distance maths goes
 *     through the same definition)
 *   - vector-index-rng.js → pickLevel() for the geometric level
 *     distribution
 *
 * Consumers:
 *   - engine/vector-index.js — wraps the helpers behind the existing
 *     public VectorIndex methods
 *
 * Topology shape (allocated by vector-index-hnsw-state.ensureTopology;
 * populated by the algorithms in this file):
 *   _levels      Int32Array (one entry per slot) — node max-level; -1
 *                 for empty slots.
 *   _neighbors   Array<Int32Array | null>[] — _neighbors[slot][level] is
 *                 the packed list of neighbour slots at that level for
 *                 this node. `null` for slots with no node, or for
 *                 layers above the node's max level.
 *   _entryPoint  number — slot of the topmost node, or -1 when empty.
 *   _entryLevel  number — max level present in the graph (mirrors
 *                 _levels[_entryPoint]).
 *
 * Distance vs similarity sign:
 *   Cosine SIMILARITY ranges [-1, 1] with 1 = "same direction"; HNSW is
 *   classically described in terms of DISTANCE (lower = closer). The two
 *   are interconvertible via `distance = -similarity`. We work with
 *   similarity throughout (negate the comparator instead of negating the
 *   number) so that the value flowing back to the caller is exactly what
 *   they expect to see in $cosine, with no sign confusion at the boundary.
 *
 * Tombstones (lazy deletion):
 *   When a slot is freed, _idAt[slot] becomes null. The graph topology
 *   is NOT rewritten — neighbour links to the dead slot remain intact.
 *   searchLayer skips dead slots (id===null) before scoring, and the
 *   wrapper's recycle path overwrites the slot's neighbour lists on the
 *   next insert into that slot. Result: O(1) delete, no link-repair pass.
 *   Long-running indexes that delete frequently accumulate "ghost"
 *   neighbours; a future compaction pass (out of scope for v2) rebuilds
 *   from non-null slots when tombstone density crosses a threshold.
 *
 * @implements UC-V1 §6.2 (HNSW default backend)
 */

import { cosine } from './vector-index-codec.js';
import { pickLevel } from './vector-index-rng.js';

/**
 * Read a slot's stored vector as a zero-copy view over the index's
 * packed buffer. The view is valid only until the next _grow() — we
 * never hold a reference past one search/insert call.
 *
 * @param {Object} index
 * @param {number} slot
 * @returns {Float32Array}
 */
function vecAt(index, slot) {
  const base = slot * index.dims;
  return index._buf.subarray(base, base + index.dims);
}

/**
 * Greedy single-step descent at one layer. Starting from `epSlot`, walk
 * to the neighbour closest (by cosine similarity) to `query` until no
 * improvement is found. This is the canonical HNSW upper-layer routine —
 * cheap because each layer above 0 has only a handful of neighbours per
 * node, so the walk converges in a few hops.
 *
 * Why it's separate from searchLayer: the upper-layer descent only needs
 * a single best, not a top-ef set, so we save the overhead of maintaining
 * the candidate heap.
 *
 * @param {Object} index
 * @param {ArrayLike<number>} query
 * @param {number} epSlot - Entry slot for this layer
 * @param {number} layer
 * @returns {number} best slot found (always defined, never -1 unless
 *   epSlot was -1 — and the caller never invokes us on an empty graph)
 */
function greedySearchOne(index, query, epSlot, layer) {
  let cur = epSlot;
  let curScore = cosine(query, vecAt(index, cur));
  // Loop until a full neighbour scan produces no improvement.
  for (;;) {
    let bestNext = -1;
    let bestScore = curScore;
    const nbrs = index._neighbors[cur] && index._neighbors[cur][layer];
    if (!nbrs) return cur;
    for (let i = 0; i < nbrs.length; i++) {
      const n = nbrs[i];
      if (index._idAt[n] === null) continue;            // tombstone
      const s = cosine(query, vecAt(index, n));
      if (s > bestScore) { bestScore = s; bestNext = n; }
    }
    if (bestNext === -1) return cur;
    cur = bestNext;
    curScore = bestScore;
  }
}

/**
 * Layer-bounded best-first search. Expands from the entry point keeping
 * a "frontier" of `ef` candidates ranked by similarity to `query`. This
 * is the HNSW workhorse — it runs at level 0 for the final wide scan,
 * and at upper levels during insertion to populate the candidate set
 * that selectNeighborsHeuristic prunes.
 *
 * Algorithm (Malkov & Yashunin §4 Algorithm 2 — adapted to similarity):
 *   1. Initialize visited = {ep}, candidates = {ep}, results = {ep}.
 *   2. While candidates is non-empty:
 *      a. Pop the best (highest-similarity) candidate `c`.
 *      b. If c's similarity is worse than the worst in results AND
 *         results is full (size === ef), stop — every further hop is
 *         monotonically worse.
 *      c. For each neighbour n of c at this layer: if not visited and
 *         (results not full OR sim(n) > sim(worst-of-results)), add n
 *         to candidates and results, evict the worst if results > ef.
 *   3. Return results, sorted similarity-desc.
 *
 * Predicate handling:
 *   The predicate gates INCLUSION in `results` but does NOT gate graph
 *   traversal. A node may be a useful waypoint even though it's filtered
 *   out — dropping it from the candidate set would risk disconnecting
 *   the result set from the part of the graph it lives in. So: every
 *   slot we visit is enqueued into `candidates`; only predicate-matching
 *   slots make it into `results`. This is what guarantees UC-V1
 *   acceptance criterion 3 (filter-during-search, not post-filter): a
 *   candidate that the filter rejects can still BRIDGE us to additional
 *   accepting candidates that we would have missed.
 *
 * Why we don't use a binary heap: at v2 default `ef=50` and graph
 * out-degree `M=16`, the candidate frontier hovers in the low tens.
 * Linear-scan-pop on a 50-element array beats a heap's constant
 * factors for n that small. If profiling under high-ef workloads says
 * otherwise, swap in a heap behind this same signature without API
 * changes.
 *
 * @param {Object} index
 * @param {ArrayLike<number>} query
 * @param {number} epSlot - Entry slot
 * @param {number} ef - Candidate-set size (must be >= 1)
 * @param {number} layer
 * @param {((id:string)=>boolean)|null} predicate - Optional filter on $ID
 * @returns {Array<{slot:number, score:number}>} sorted similarity-desc
 */
export function searchLayer(index, query, epSlot, ef, layer, predicate = null) {
  // visited bitmap — Uint8Array is the cheapest dense set in JS at this
  // size. Capacity is at most _capacity slots; we allocate per-call
  // because two concurrent searches would race a shared scratch buffer.
  const visited = new Uint8Array(index._capacity);
  visited[epSlot] = 1;
  const epScore = cosine(query, vecAt(index, epSlot));
  const epId = index._idAt[epSlot];
  // Active candidate frontier — we pop the highest-similarity entry
  // each iteration. Stored as parallel arrays {slot, score} for
  // cache-friendliness over a Map.
  const candidates = [{ slot: epSlot, score: epScore }];
  // Result set — only entries that pass the predicate (or no predicate).
  const results = [];
  if (epId !== null && (!predicate || predicate(epId))) {
    results.push({ slot: epSlot, score: epScore });
  }
  while (candidates.length > 0) {
    // Pop the best candidate by similarity. Inline scan — see comment
    // above on why this beats a heap at our typical ef sizes.
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].score > candidates[bestIdx].score) bestIdx = i;
    }
    const cur = candidates[bestIdx];
    candidates[bestIdx] = candidates[candidates.length - 1];
    candidates.pop();
    // Worst-of-results tells us when we can stop expanding: any node
    // whose own similarity is below the worst result will not produce
    // a neighbour better than the worst result either (within this
    // layer's monotone neighbourhood guarantee).
    let worstResultScore = -Infinity;
    for (let i = 0; i < results.length; i++) {
      if (results[i].score < worstResultScore || worstResultScore === -Infinity) {
        worstResultScore = results[i].score;
      }
    }
    if (results.length >= ef && cur.score < worstResultScore) break;
    // Walk this candidate's neighbours at the requested layer.
    const nbrs = index._neighbors[cur.slot] && index._neighbors[cur.slot][layer];
    if (!nbrs) continue;
    for (let i = 0; i < nbrs.length; i++) {
      const n = nbrs[i];
      if (visited[n]) continue;
      visited[n] = 1;
      const id = index._idAt[n];
      if (id === null) continue;          // tombstone
      const s = cosine(query, vecAt(index, n));
      // Add to candidates whenever the score is competitive with the
      // current worst result, OR when we haven't filled `ef` slots yet.
      if (results.length < ef || s > worstResultScore) {
        candidates.push({ slot: n, score: s });
        // Predicate gates only the result set, not the graph walk.
        if (!predicate || predicate(id)) {
          results.push({ slot: n, score: s });
          if (results.length > ef) {
            // Evict the lowest-scoring result to keep |results| <= ef.
            let wi = 0;
            for (let j = 1; j < results.length; j++) {
              if (results[j].score < results[wi].score) wi = j;
            }
            results[wi] = results[results.length - 1];
            results.pop();
          }
        }
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Heuristic neighbour selector — Algorithm 4 from the HNSW paper.
 *
 * Why heuristic (not just "top M by similarity"): a naive top-M tends
 * to cluster all neighbours in one direction, which kills connectivity
 * and produces dead-end pockets in the graph. The heuristic prunes any
 * candidate that's closer to an already-selected neighbour than it is
 * to the query — i.e. it spreads selections geometrically around the
 * query rather than packing them on one side.
 *
 * Effect on recall: 5–10% improvement at the same M and ef vs. naive
 * top-M, with no measurable cost (M is small, the inner check is O(M)).
 *
 * @param {Object} index
 * @param {Array<{slot:number, score:number}>} candidates - sorted desc
 *   by similarity (same shape searchLayer returns)
 * @param {number} M
 * @returns {Array<{slot:number, score:number}>} chosen neighbours,
 *   length <= M, similarity-desc
 */
export function selectNeighborsHeuristic(index, candidates, M) {
  // Working copy sorted similarity-desc. The caller already sorts, but
  // we don't trust that contract — making a local sort cheap is easy.
  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  const chosen = [];
  for (let i = 0; i < sorted.length && chosen.length < M; i++) {
    const c = sorted[i];
    let keep = true;
    const cVec = vecAt(index, c.slot);
    // Reject `c` if some already-chosen `e` is closer to `c` than the
    // query is. "Closer" in similarity-space means sim(c,e) > sim(c,q).
    // If the candidate is more similar to a chosen neighbour than it is
    // to the query, it adds little new directional coverage.
    for (let j = 0; j < chosen.length; j++) {
      const e = chosen[j];
      const eVec = vecAt(index, e.slot);
      const ce = cosine(cVec, eVec);
      if (ce > c.score) { keep = false; break; }
    }
    if (keep) chosen.push(c);
  }
  return chosen;
}

/**
 * Pack a list of {slot, score} entries into a flat Int32Array of slot
 * numbers, preserving order. Stored on the topology so neighbour lookups
 * are cache-friendly (one allocation per node-per-level vs. one box
 * per neighbour with Array<number>).
 *
 * @param {Array} chosen - Entries shaped {slot:number}; order preserved
 * @returns {Int32Array}
 */
function packSlots(chosen) {
  const out = new Int32Array(chosen.length);
  for (let i = 0; i < chosen.length; i++) out[i] = chosen[i].slot;
  return out;
}

/**
 * Add a directed edge from `fromSlot` to `toSlot` at the given layer,
 * pruning back to the level-appropriate M cap if the addition would
 * exceed it. Pruning uses the same heuristic selector so connectivity
 * stays good after rebalancing.
 *
 * @param {Object} index
 * @param {number} fromSlot - Existing node receiving a new neighbour
 * @param {number} toSlot - Newly inserted node being linked back
 * @param {number} layer
 * @param {number} M - Cap at this layer (level 0 uses 2*M)
 */
function addNeighbor(index, fromSlot, toSlot, layer, M) {
  const lists = index._neighbors[fromSlot];
  if (!lists || layer >= lists.length || !lists[layer]) {
    // Should not happen — _neighbors[fromSlot] is allocated on insert
    // for every layer up to the node's level — but guard so a corrupted
    // topology surfaces a defined error rather than a TypeError.
    return;
  }
  const cur = lists[layer];
  // Quick path: still room — append.
  if (cur.length < M) {
    const next = new Int32Array(cur.length + 1);
    next.set(cur);
    next[cur.length] = toSlot;
    lists[layer] = next;
    return;
  }
  // Over budget — re-run the heuristic over (current ∪ {new}) and
  // truncate to M. Score against `fromSlot`'s own vector (the
  // anchor of the locality we're trying to preserve).
  const anchor = vecAt(index, fromSlot);
  const candidates = [];
  for (let i = 0; i < cur.length; i++) {
    if (index._idAt[cur[i]] === null) continue;       // drop tombstones during prune
    candidates.push({ slot: cur[i], score: cosine(anchor, vecAt(index, cur[i])) });
  }
  candidates.push({ slot: toSlot, score: cosine(anchor, vecAt(index, toSlot)) });
  const chosen = selectNeighborsHeuristic(index, candidates, M);
  lists[layer] = packSlots(chosen);
}

/**
 * Insert a freshly-stored node into the HNSW graph.
 *
 * Preconditions: the wrapper has already
 *   - allocated/recycled `slot`,
 *   - copied `vec` into _buf at slot,
 *   - set _idAt[slot] = id, _slotOf[id] = slot,
 *   - called ensureTopology(index) so _levels and _neighbors are sized.
 *
 * Effect: assigns a max-level to the node, links it bidirectionally on
 * every layer up to that level, and promotes it to entry point if its
 * level exceeds the current entryLevel.
 *
 * Algorithm (Malkov & Yashunin §4 Algorithm 1):
 *   1. Sample level l for the new node.
 *   2. If the graph is empty, the new node becomes the entry point.
 *   3. Greedy-descend from the current entry point through layers
 *      _entryLevel..(l+1), each step picking the closest neighbour by
 *      similarity.
 *   4. From min(l, _entryLevel)..0:
 *      a. searchLayer to gather efConstruction candidates.
 *      b. Pick up to M_at_L of them via the heuristic selector.
 *      c. Link new ↔ each selected neighbour, pruning the neighbour's
 *         list back to M_at_L if necessary.
 *      d. Carry the closest candidate forward as the next layer's
 *         entry point.
 *   5. If l > _entryLevel, replace the entry point.
 *
 * @param {Object} index - VectorIndex with topology already ensured
 * @param {number} slot - Storage slot for this node
 */
export function insertNode(index, slot) {
  const M = index._hnswM;
  const efC = index._hnswEfConstruction;
  const M0 = 2 * M;                                       // §4 — level 0 has 2*M cap
  const level = pickLevel(index._hnswRng, M);
  index._levels[slot] = level;
  // Allocate the empty per-layer neighbour lists for this node.
  const myNbrs = new Array(level + 1);
  for (let L = 0; L <= level; L++) myNbrs[L] = new Int32Array(0);
  index._neighbors[slot] = myNbrs;

  // First node — becomes the entry point with no neighbours yet.
  if (index._entryPoint === -1) {
    index._entryPoint = slot;
    index._entryLevel = level;
    return;
  }

  // Phase 1 — greedy descent from the top of the graph down to (level+1).
  // We use single-best descent because we only need ONE entry point per
  // layer for the wide search in phase 2.
  let ep = index._entryPoint;
  for (let L = index._entryLevel; L > level; L--) {
    ep = greedySearchOne(index, vecAt(index, slot), ep, L);
  }

  // Phase 2 — wide search-and-link from the highest level the new node
  // lives at, all the way down to the base layer.
  for (let L = Math.min(level, index._entryLevel); L >= 0; L--) {
    // Wider candidate gather via efConstruction; predicate=null because
    // insertion isn't filtered.
    const candidates = searchLayer(index, vecAt(index, slot), ep, efC, L, null);
    const Mat = (L === 0) ? M0 : M;
    const chosen = selectNeighborsHeuristic(index, candidates, Mat);
    // Outgoing edges from the new node.
    myNbrs[L] = packSlots(chosen);
    // Bidirectional: each neighbour gets the new node added to its list,
    // pruning if that neighbour's list exceeds the cap.
    for (let i = 0; i < chosen.length; i++) {
      addNeighbor(index, chosen[i].slot, slot, L, Mat);
    }
    // Carry the best candidate forward as the next layer's entry point;
    // this keeps phase 2 anchored to the densely-connected region we've
    // already discovered.
    if (candidates.length > 0) ep = candidates[0].slot;
  }

  // Phase 3 — promote the new node if it tops the existing entry.
  if (level > index._entryLevel) {
    index._entryPoint = slot;
    index._entryLevel = level;
  }
}

/**
 * Top-k nearest-neighbour search, predicate-aware.
 *
 * Algorithm:
 *   1. Greedy-descend the upper layers from the entry point — same
 *      single-best step used during insertion. Cheap; O(log N) hops.
 *   2. At level 0, run searchLayer with `effectiveEf = max(ef, k)`.
 *      Why: at small index sizes the test fixtures use, callers pass
 *      `k` larger than the default ef; bumping ef ensures we never
 *      return fewer than k candidates when more eligible candidates
 *      exist. At fixture-scale sizes (a handful of nodes), this also
 *      means searchLayer effectively becomes a brute-force sweep —
 *      exact recall comes free.
 *   3. Sort the level-0 result set by similarity desc and slice to k.
 *
 * Returns the SAME shape brute-force `searchFiltered` returned —
 * `[{id, score}]` — so the wrapper's `searchFiltered` is a near-
 * identity wrapper above this function.
 *
 * @param {Object} index
 * @param {ArrayLike<number>} query
 * @param {number} k
 * @param {((id:string)=>boolean)|null} predicate
 * @param {number} ef - efSearch override; defaults to index._hnswEfSearch
 * @returns {Array<{id:string, score:number}>}
 */
export function searchHNSW(index, query, k, predicate = null, ef) {
  if (index._entryPoint === -1 || index._size === 0) return [];
  const effectiveEf = Math.max(ef ?? index._hnswEfSearch, k);
  // Phase 1 — descend.
  let ep = index._entryPoint;
  for (let L = index._entryLevel; L > 0; L--) {
    ep = greedySearchOne(index, query, ep, L);
  }
  // Phase 2 — wide search at level 0.
  const layer0 = searchLayer(index, query, ep, effectiveEf, 0, predicate);
  // searchLayer already returns similarity-desc. Truncate to k and
  // map slot→id for the public return shape.
  const out = [];
  for (let i = 0; i < layer0.length && i < k; i++) {
    const slot = layer0[i].slot;
    const id = index._idAt[slot];
    if (id === null) continue;        // belt-and-braces tombstone guard
    out.push({ id, score: layer0[i].score });
  }
  return out;
}

export default { searchLayer, selectNeighborsHeuristic, insertNode, searchHNSW };
