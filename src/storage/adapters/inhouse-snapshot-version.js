/**
 * @file Snapshot version selection for the in-house adapter.
 *
 * Domain context: Bri snapshots are append-only compatibility contracts. New
 * persisted capabilities must bump the writer version while older versions stay
 * readable.
 *
 * Technical context: version precedence is payload-driven. Collection identity
 * state is v5 and includes all previous v3/v4 payload shapes when present.
 */

/**
 * Pick the snapshot version for the current adapter state.
 *
 * @param {Object} flags - Payload presence flags.
 * @param {boolean} flags.hasIdentityState - Collection identity catalog present.
 * @param {boolean} flags.hasV4Payload - Graph adjacency payload present.
 * @param {boolean} flags.hasV3Payload - Vector or secondary-index payload present.
 * @returns {number} Snapshot version to write.
 */
export function chooseSnapshotVersion({ hasIdentityState, hasV4Payload, hasV3Payload }) {
  if (hasIdentityState) return 5;
  if (hasV4Payload) return 4;
  if (hasV3Payload) return 3;
  return 2;
}

/**
 * Convert the adapter's identity map into a plain snapshot payload.
 *
 * @param {Map<string,string>|undefined} identities - Adapter identity map.
 * @returns {{state:Object, hasIdentityState:boolean}} Snapshot-ready state.
 */
export function collectionIdentitySnapshotState(identities) {
  const state = Object.fromEntries(identities || []);
  return {
    state,
    hasIdentityState: Object.keys(state).length > 0
  };
}
