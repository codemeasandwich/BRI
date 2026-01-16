// Core symbols
export { UNDECLARED } from './src/symbols.js';

// Change tracking
export { createChangeTracker } from './src/watch.js';

// Apply changes
export { applyChanges } from './src/apply.js';

// Path utilities
export { getByPath, pathStartsWith, pathEquals } from './src/path.js';

// Object traversal
export { flattenToPathValues, isPlainObject } from './src/traverse.js';

// Matching utilities
export { isPartialMatch, isDeepEqual } from './src/match.js';

// Patch generation
export { createPatch } from './src/patch.js';
