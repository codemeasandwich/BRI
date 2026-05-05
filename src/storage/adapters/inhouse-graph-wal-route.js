/**
 * @file Shared routing from document $ID keys into the persistent GraphIndex.
 *
 * Domain: WAL recovery for edge collections (UC-G7 / Persistent GraphIndex).
 *   When a v4 snapshot loaded GraphIndex state, the WAL post-snapshot may
 *   contain edge writes (or deletes) that must be applied on top of the
 *   loaded adjacency. The schema registry isn't constructed at recover()
 *   time, so we can't call graphIndex.insertEdge/removeEdge directly —
 *   instead we identify the edge collection from the doc's $ID prefix
 *   (using the persisted GraphIndex specs) and buffer the op into a
 *   deferred queue that bindGraphIndex drains.
 *
 * Why this lives next to inhouse-vector-wal-route.js: the two paths are
 * structurally identical — both project a doc's $ID prefix onto a per-
 * collection lookup. Co-locating keeps the WAL-replay routing surface
 * reviewable as one concept.
 *
 * Consumed by: storage/adapters/inhouse-recovery.js
 *   (applyGraphWrite / applyGraphDelete in the WAL replay loop).
 * Consumes: engine/types.js for type2Short prefix derivation.
 */

import { type2Short } from '../../engine/types.js';

/**
 * Build a prefix string (e.g. KGTR) → {collection, edgeSpec} map from a
 * loaded GraphIndex serialization payload. Returns an empty Map when the
 * payload is null / missing — the caller treats that as "no graph state
 * loaded; skip the deferred-op buffering path entirely."
 *
 * Why we read from the serialized state rather than the live index: at
 * recover() time the live GraphIndex hasn't been constructed yet (the
 * schema registry is built after recover() resolves). The serialized
 * snapshot payload carries the `specs` map which is exactly what we
 * need to identify edge collections from a $ID prefix.
 *
 * @param {Object|null} pendingState - GraphIndex.serialize() payload
 *   (`{specs, outgoing, incoming}`), or null when no graph state was
 *   loaded (fresh DB / v3-or-earlier snapshot).
 * @returns {Map<string, {collection:string, edgeSpec:Object}>}
 */
export function buildPrefixToEdgeCollectionMap(pendingState) {
  const out = new Map();
  if (!pendingState || !pendingState.specs) return out;
  for (const [collection, edgeSpec] of Object.entries(pendingState.specs)) {
    out.set(type2Short(collection), { collection, edgeSpec });
  }
  return out;
}

export default buildPrefixToEdgeCollectionMap;
