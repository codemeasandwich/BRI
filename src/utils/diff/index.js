/**
 * @file Diff utilities — façade over `utils/diff/src/*`.
 *
 * Assign-and-export bindings (rather than bare re-export directives) keeps
 * this module visible to V8 statement coverage — `export * from './x'` and
 * `export { foo } from './x'` are not instrumented as executable lines under
 * the project's Jest + Node ESM setup.
 */

import { UNDECLARED as UNDECLARED_IMPL } from './src/symbols.js';
import { createChangeTracker as createChangeTrackerImpl } from './src/watch.js';
import { applyChanges as applyChangesImpl } from './src/apply.js';
import { getByPath as getByPathImpl, pathStartsWith as pathStartsWithImpl, pathEquals as pathEqualsImpl } from './src/path.js';
import { flattenToPathValues as flattenToPathValuesImpl, isPlainObject as isPlainObjectImpl } from './src/traverse.js';
import { isPartialMatch as isPartialMatchImpl, isDeepEqual as isDeepEqualImpl } from './src/match.js';
import { createPatch as createPatchImpl, pathToPointer as pathToPointerImpl } from './src/patch.js';

export const UNDECLARED = UNDECLARED_IMPL;
export const createChangeTracker = createChangeTrackerImpl;
export const applyChanges = applyChangesImpl;
export const getByPath = getByPathImpl;
export const pathStartsWith = pathStartsWithImpl;
export const pathEquals = pathEqualsImpl;
export const flattenToPathValues = flattenToPathValuesImpl;
export const isPlainObject = isPlainObjectImpl;
export const isPartialMatch = isPartialMatchImpl;
export const isDeepEqual = isDeepEqualImpl;
export const createPatch = createPatchImpl;
export const pathToPointer = pathToPointerImpl;
