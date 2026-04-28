/**
 * @file Topology lifecycle helpers for the HNSW index — allocation,
 * lazy deletion, and v1→v2 rebuild.
 *
 * Role in the system:
 *   The HNSW algorithm in vector-index-hnsw.js operates on the topology
 *   arrays (_levels, _neighbors, _entryPoint, _entryLevel) hung off the
 *   VectorIndex instance. THIS module owns the lifecycle of those arrays:
 *     - ensureTopology — first-time allocation + grow-after-resize
 *     - dropNode       — lazy delete (mark slot dead, re-elect entry)
 *     - rebuildTopology — full rebuild when deserializing a v1 snapshot
 *
 *   Separated from the algorithmic core to keep both files at or under
 *   the 200-NCLOC ceiling and to give state lifecycle its own reviewable
 *   surface — callers reading the algorithm don't need to wade through
 *   the lifecycle plumbing, and vice versa.
 *
 * Dependencies:
 *   - vector-index-hnsw.js (insertNode) — ONLY in rebuildTopology, which
 *     re-inserts every populated slot to reconstruct the graph.
 *
 * Consumers:
 *   - engine/vector-index.js — constructor (ensureTopology), _grow
 *     (ensureTopology), remove (dropNode), deserialize (rebuildTopology)
 *
 * Why these helpers don't `import` the index class itself: every helper
 * takes the index as a structured first argument, the same pattern used
 * by vector-index-hnsw.js — keeps tests trivially driveable and prevents
 * circular imports between this module and vector-index.js.
 */

import { insertNode } from './vector-index-hnsw.js';

/**
 * Allocate or grow the per-slot level table and neighbour-list array.
 * Called once from the wrapper constructor and after every _grow() so
 * the topology stays aligned with slot storage's current capacity.
 *
 * Why Int32Array for _levels (not Array<number>): two-thirds the memory
 * at scale and skips boxing on every read.
 *
 * Why -1 sentinel (not undefined / null): JIT-friendly typed-array
 * comparisons stay numeric — `_levels[slot] !== -1` is one int compare,
 * no implicit conversion.
 *
 * @param {Object} index - VectorIndex instance with `_capacity` set
 * @returns {void} mutates `index`
 */
export function ensureTopology(index) {
  // Fresh allocation when there's no level table yet (constructor path).
  if (!index._levels) {
    index._levels = new Int32Array(index._capacity);
    index._levels.fill(-1);
    index._neighbors = new Array(index._capacity).fill(null);
    index._entryPoint = -1;
    index._entryLevel = -1;
    return;
  }
  // Grow path: extend in place. The wrapper already grew _buf and _idAt;
  // mirror that by allocating new backing arrays at the new capacity and
  // copying the existing entries forward.
  if (index._levels.length < index._capacity) {
    const newLevels = new Int32Array(index._capacity);
    newLevels.fill(-1);
    newLevels.set(index._levels);
    index._levels = newLevels;
    const newNbrs = new Array(index._capacity).fill(null);
    for (let i = 0; i < index._neighbors.length; i++) {
      newNbrs[i] = index._neighbors[i];
    }
    index._neighbors = newNbrs;
  }
}

/**
 * Drop a slot from the topology — lazy delete.
 *
 * Effect: clears the slot's neighbour lists and level marker; re-elects
 * the entry point if we just deleted it. Other nodes' neighbour lists
 * still reference this slot; searchLayer skips it via _idAt[n] === null.
 *
 * Why we clear the slot's lists (instead of leaving them): when the slot
 * is recycled for a new node, the wrapper calls insertNode which sets
 * up fresh lists. Leaving stale lists in place would leak through if
 * insertNode were ever skipped on recycle.
 *
 * Why entry-point re-election scans all slots: it runs only when the
 * deleted slot WAS the entry point — rare. The O(capacity) cost is
 * acceptable in exchange for keeping the topology coherent.
 *
 * @param {Object} index
 * @param {number} slot
 */
export function dropNode(index, slot) {
  index._neighbors[slot] = null;
  index._levels[slot] = -1;
  if (slot === index._entryPoint) {
    let bestSlot = -1;
    let bestLevel = -1;
    for (let i = 0; i < index._capacity; i++) {
      if (index._idAt[i] === null) continue;
      if (index._levels[i] > bestLevel) {
        bestLevel = index._levels[i];
        bestSlot = i;
      }
    }
    index._entryPoint = bestSlot;
    index._entryLevel = bestLevel;
  }
}

/**
 * Reconstruct the entire HNSW graph by re-inserting every occupied slot.
 * Used by the wrapper when a v1-format snapshot is deserialized — v1
 * carried slot storage but no topology, so we rebuild on first boot.
 *
 * Cost: O(N · M · log N) — standard HNSW build cost. At 10k nodes with
 * M=16 this runs in ~1 second on a typical laptop. Logged so operators
 * see the one-shot startup delay.
 *
 * Why eager (not lazy): the schema-registry hands the index to the user
 * immediately after deserialize; queries that hit before the rebuild
 * would return zero results because _entryPoint is -1. Eager rebuild
 * trades startup latency for correctness at first query.
 *
 * @param {Object} index - VectorIndex with slot storage populated and
 *   topology arrays already allocated (ensureTopology already called)
 */
export function rebuildTopology(index) {
  index._levels.fill(-1);
  for (let i = 0; i < index._neighbors.length; i++) index._neighbors[i] = null;
  index._entryPoint = -1;
  index._entryLevel = -1;
  let count = 0;
  for (let slot = 0; slot < index._capacity; slot++) {
    if (index._idAt[slot] === null) continue;
    insertNode(index, slot);
    count++;
  }
  if (count > 0) {
    console.log(`VectorIndex: rebuilt HNSW topology from ${count} vectors`);
  }
}

export default { ensureTopology, dropNode, rebuildTopology };
