/**
 * BRI Engine - Core database engine factory
 *
 * Creates the internal wrapper with all CRUD operations.
 */

import { createIdGenerator } from './id.js';
import { createPublisher, type2Short } from './types.js';
import { createOperations } from './operations.js';

/**
 * Create a database engine instance
 * @param {Object} store - Storage adapter
 * @returns {Object} - Engine wrapper with sub, create, update, remove, get, cache, replace
 */
export function createEngine(store) {
  const { genid, makeid, idIsFree } = createIdGenerator(store);
  const publish = createPublisher(store, genid);

  const wrapper = createOperations(store, { genid, publish });

  return wrapper;
}

// Re-export utilities
export { type2Short } from './types.js';
export * from './constants.js';
export * from './helpers.js';
export { watchForChanges } from './reactive.js';
