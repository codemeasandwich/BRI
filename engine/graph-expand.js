/**
 * @file Multi-hop BFS expansion — `entity.expand({...})` per spec §2.6.
 *
 * Given a seed entity, walk outward through an edge collection up to the
 * declared hop budget, optionally filtered by predicate or direction,
 * collecting reachable nodes, edges, and paths. Cycle detection uses a
 * per-traversal visited-set on node $IDs so a cyclic graph cannot loop
 * forever; a results-count budget caps the working set so traversal is
 * O(min(reachable, results-budget)).
 *
 * Why a free module (not a method on PredicateAccessor): the implementation
 * is parameter-rich and self-contained — making it a free function keeps
 * the predicate-proxy resolution algorithm focused on lookup, not graph
 * algorithmics. The proxy's `.expand` accessor calls into this module.
 *
 * Output shape (matches the spec example):
 *   {
 *     nodes: [...entities],
 *     edges: [...edge documents],
 *     paths: [[seedId, edgeId, nodeId, edgeId, nodeId, ...], ...],
 *     complete: boolean,
 *     incompleteReason: 'time' | 'results' | undefined,
 *   }
 *
 * @implements UC-G6
 */

/**
 * Run the BFS expansion.
 *
 * @param {Object} args
 * @param {string} args.seedId - $ID of the entity to expand from
 * @param {string} args.via - Edge collection name
 * @param {number} [args.hops=1] - Max hop depth
 * @param {Object} [args.budget] - {results: N, ms: M}
 * @param {Array<string>} [args.predicates] - Whitelist of predicate names
 * @param {'out'|'in'|'both'} [args.direction='out']
 * @param {Function} [args.edgeFilter] - Optional `(edge) => boolean`; v1 accepts function form only
 * @param {Object} args.registry - Schema registry (graphIndex, edgeSpec, ...)
 * @param {Object} args.wrapper - Engine wrapper (for hydration)
 * @returns {Promise<Object>} {nodes, edges, paths, complete, incompleteReason}
 */
export async function expand(args) {
  const {
    seedId, via, hops = 1, budget = {}, predicates = null,
    direction = 'out', edgeFilter = null,
    registry, wrapper
  } = args;
  const graphIndex = registry.graphIndex();
  const edgeSpec = registry.edgeSpec(via);
  if (!edgeSpec) {
    throw new Error(`expand: collection '${via}' is not a registered edge collection`);
  }

  const visitedNodes = new Set([seedId]);
  const visitedEdges = new Set();
  const nodeIds = [];          // discovered nodes (excluding seed)
  const edgeDocs = [];
  const paths = [[seedId]];
  let frontier = [{ nodeId: seedId, path: [seedId] }];

  // Budget tracking. Time budget is checked between hop iterations (not
  // per-edge) to avoid measurement overhead dominating tiny graphs.
  const startMs = Date.now();
  const resultsBudget = typeof budget.results === 'number' ? budget.results : Infinity;
  const msBudget = typeof budget.ms === 'number' ? budget.ms : Infinity;
  let complete = true;
  let incompleteReason = undefined;

  for (let hop = 0; hop < hops; hop++) {
    if (Date.now() - startMs > msBudget) {
      complete = false;
      incompleteReason = 'time';
      break;
    }
    const nextFrontier = [];
    let stop = false;
    for (const { nodeId, path } of frontier) {
      if (stop) break;
      const edgeIds = collectEdgeIds(graphIndex, nodeId, via, predicates, direction);
      for (const edgeId of edgeIds) {
        if (visitedEdges.has(edgeId)) continue;
        const edge = await wrapper.get(via, edgeId);
        // Phantom adjacency entries (the doc was deleted but adjacency
        // wasn't cleaned) hydrate to null — skip silently per spec
        // resilience criterion.
        if (!edge) continue;
        if (edgeFilter && !edgeFilter(edge)) continue;
        visitedEdges.add(edgeId);
        edgeDocs.push(edge);

        const nextNodeId = pickNextNode(edge, edgeSpec, nodeId, direction);
        if (!nextNodeId) continue;
        const nextPath = [...path, edgeId, nextNodeId];
        paths.push(nextPath);
        if (!visitedNodes.has(nextNodeId)) {
          visitedNodes.add(nextNodeId);
          nodeIds.push(nextNodeId);
          if (nodeIds.length >= resultsBudget) {
            complete = false;
            incompleteReason = 'results';
            stop = true;
            break;
          }
          nextFrontier.push({ nodeId: nextNodeId, path: nextPath });
        }
      }
    }
    if (stop) break;
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Hydrate node entities. Bounded by visitedNodes - {seed} so this is
  // O(reachable nodes), not O(collection).
  const nodes = await Promise.all(
    nodeIds.map(id => wrapper.get(null, id))
  );
  return {
    nodes: nodes.filter(Boolean),
    edges: edgeDocs,
    paths,
    complete,
    incompleteReason
  };
}

/**
 * Collect edge $IDs leaving (or entering) a node. Honors the predicate
 * whitelist by intersecting with the per-predicate adjacency or, when no
 * predicate filter is supplied, taking the full unfiltered list.
 *
 * @param {Object} graphIndex
 * @param {string} nodeId
 * @param {string} via - Edge collection
 * @param {Array<string>|null} predicates - Whitelist; null means all
 * @param {'out'|'in'|'both'} direction
 * @returns {Array<string>}
 */
function collectEdgeIds(graphIndex, nodeId, via, predicates, direction) {
  const out = [];
  /**
   * Append every id from `ids` to the output buffer.
   * @param {Iterable<string>} ids
   */
  const collect = (ids) => { for (const id of ids) out.push(id); };
  const dirs = direction === 'both' ? ['out', 'in']
             : direction === 'in'   ? ['in']
             :                        ['out'];
  for (const d of dirs) {
    const fn = d === 'out' ? graphIndex.outgoing.bind(graphIndex)
                           : graphIndex.incoming.bind(graphIndex);
    if (predicates) {
      for (const p of predicates) collect(fn(nodeId, via, p));
    } else {
      collect(fn(nodeId, via));
    }
  }
  return out;
}

/**
 * Given an edge doc, the current node, and the traversal direction, pick
 * the OTHER endpoint to continue the walk. Outgoing → other = to-field.
 * Incoming → other = from-field. Both → whichever endpoint isn't the
 * current node.
 *
 * @param {Object} edge
 * @param {Object} edgeSpec - {from, to, ...}
 * @param {string} currentNodeId
 * @param {'out'|'in'|'both'} direction
 * @returns {string|null}
 */
function pickNextNode(edge, edgeSpec, currentNodeId, direction) {
  if (direction === 'out') return edge[edgeSpec.to];
  if (direction === 'in')  return edge[edgeSpec.from];
  // 'both': the other endpoint, whichever it is
  if (edge[edgeSpec.from] === currentNodeId) return edge[edgeSpec.to];
  return edge[edgeSpec.from];
}

export default expand;
