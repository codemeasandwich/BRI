/**
 * @file BRI Engine — core database engine factory.
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
export { createIdGenerator } from './id.js';
export { type2Short } from './types.js';
export * from './constants.js';
export * from './helpers.js';
export { watchForChanges } from './reactive.js';

/**
 * Advanced: direct access for extensions, benchmarking, and deterministic
 * transaction-buffer tests. Normal applications use schema-backed vectors via
 * `createDB`; these exports expose the underlying index types without reaching
 * for deep import paths outside `package.json` exports.
 */
export { VectorIndex } from './vector-index.js';
export { GraphIndex } from './graph-index.js';

// Typed-error surface (`utils/schema`, middleware, predicates) resolves through
// the same `./engine` specifier as `createEngine`; re-export alongside.
export * from './errors.js';

// Middleware plugs — use `import { loggingMiddleware } from 'bri-db/engine'` (also
// `bri-db/engine/middleware.js` for deep imports).
export * from './middleware.js';
