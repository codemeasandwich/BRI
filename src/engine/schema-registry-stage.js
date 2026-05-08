/**
 * @file Staging helpers for atomic schema-registry declarations.
 *
 * Domain context: schema declaration touches identity, graph, predicate,
 * secondary-index, cascade, lifecycle, and vector state. Bri must validate all
 * of that work before mutating the live registry so failed declarations do not
 * poison later collection identity checks.
 *
 * Technical context: these helpers copy staged maps into existing live
 * containers so references held by query planners and middleware remain stable
 * while the contents advance atomically at commit time.
 */

import { VectorIndex } from './vector-index.js';

/**
 * Clone a predicate routing table without sharing nested maps.
 *
 * @param {Map<string, Map<string, string>>} source - Routing map.
 * @returns {Map<string, Map<string, string>>} Detached clone.
 */
export function cloneRoutingMap(source) {
  return new Map([...source.entries()].map(([key, value]) => [key, new Map(value)]));
}

/**
 * Replace a map's contents in place so existing references remain valid.
 *
 * @param {Map} target - Map to mutate.
 * @param {Map} source - Source entries to copy.
 */
export function replaceMapContents(target, source) {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

/**
 * Replace a set's contents in place so registry references stay stable.
 *
 * @param {Set} target - Set to mutate.
 * @param {Set} source - Source entries to copy.
 */
export function replaceSetContents(target, source) {
  target.clear();
  for (const value of source) target.add(value);
}

/**
 * Append validated cascade entries to the live scope map at schema commit.
 *
 * @param {Map<string, Array<Object>>} cascadeByScope - Live cascade map.
 * @param {Array<Object>} entries - Staged entries with `scope`.
 */
export function applyCascadeEntries(cascadeByScope, entries) {
  for (const { scope, ...entry } of entries) {
    if (!cascadeByScope.has(scope)) cascadeByScope.set(scope, []);
    cascadeByScope.get(scope).push(entry);
  }
}

/**
 * Build the vector-index commit plan after drift validation succeeds.
 *
 * @param {Object} store - Optional storage adapter with persisted vector state.
 * @param {string} collection - Collection being declared.
 * @param {Object} vec - Vector field declaration from the schema.
 * @returns {Object} Commit plan for live vector maps and snapshot binding.
 */
export function planVectorIndex(store, collection, vec) {
  const persisted = store && typeof store.getVectorEntry === 'function'
    ? store.getVectorEntry(collection)
    : undefined;
  if (!persisted) {
    return {
      field: vec.name,
      schema: { field: vec.name, dims: vec.dims, metric: vec.metric },
      index: new VectorIndex({ dims: vec.dims, metric: vec.metric }),
      persisted: false
    };
  }
  const ps = persisted.schema;
  if (ps.dims !== vec.dims || (ps.metric || 'cosine') !== vec.metric) {
    throw new Error(
      `Vector index drift on '${collection}': persisted index has ` +
      `dims=${ps.dims}/metric=${ps.metric || 'cosine'}, ` +
      `but new schema declares dims=${vec.dims}/metric=${vec.metric}. ` +
      `Revert the schema change or delete the data directory to rebuild.`
    );
  }
  if (ps.field !== vec.name) {
    throw new Error(
      `Vector field rename on '${collection}': persisted index targets ` +
      `field '${ps.field}', but new schema declares field '${vec.name}'. ` +
      `Rename in the schema is not auto-migrated; either keep the old ` +
      `field name or delete the data directory to rebuild.`
    );
  }
  return { field: vec.name, index: persisted.index, persisted: true };
}

/**
 * Commit a validated vector plan into the live registry and storage binding.
 *
 * @param {Object} args - Commit dependencies.
 * @param {Object} args.store - Optional storage adapter.
 * @param {string} args.collection - Collection being declared.
 * @param {Object} args.vectorPlan - Plan produced by {@link planVectorIndex}.
 * @param {Map<string, string>} args.vectorFields - Live collection-to-field map.
 * @param {Map<string, Object>} args.vectorIndices - Live collection-to-index map.
 * @returns {void}
 */
export function commitVectorPlan({ store, collection, vectorPlan, vectorFields, vectorIndices }) {
  vectorFields.set(collection, vectorPlan.field);
  vectorIndices.set(collection, vectorPlan.index);
  if (!vectorPlan.persisted && store && typeof store.registerVectorIndex === 'function') {
    store.registerVectorIndex(collection, vectorPlan.schema, vectorPlan.index);
  }
}
