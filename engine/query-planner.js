/**
 * @file Query planner — turns a `.where(filter)` declaration into an
 * execution plan that chooses between secondary-index lookup and a fallback
 * full-collection scan.
 *
 * Why a planner module instead of inlining the logic in QueryBuilder:
 *   - Decoupling: QueryBuilder no longer needs to know about indexes; it
 *     consumes a uniform `{candidateIds, residualFilter}` plan.
 *   - Testability: planning is pure (registry in, plan out) so the policy
 *     can be exercised without spinning up a database.
 *   - Future extensibility: when we add `.range()` filters or `.combine()`
 *     blends, the planning shape (candidateIds + residual) still applies;
 *     only the planner grows.
 *
 * v1 scope:
 *   - Equality-only filters (`{field: value}`)
 *   - Compound prefix matching against a single best-fit index
 *   - Residual-field detection: any filter field not covered by the chosen
 *     index falls into a JS-level filter that runs after candidate hydration
 *
 * Out of scope until later slices:
 *   - Multi-index intersection (would require id-set intersection over
 *     multiple lookups; correctness gain is small and code path explodes)
 *   - $or / $in / range operators
 *
 * @implements engine portion of UC-X1 prefilter path
 */

import { compileFilter } from './filter-compiler.js';

/**
 * Strip the index-covered fields from an object filter, returning the
 * residual filter (or null if every field was covered).
 *
 * @param {Object} filter - Original filter (must be an object)
 * @param {Array<string>} covered - Fields the chosen index already filtered
 * @returns {Object|null}
 */
function stripCovered(filter, covered) {
  const set = new Set(covered);
  const out = {};
  let any = false;
  for (const k of Object.keys(filter)) {
    if (!set.has(k)) {
      out[k] = filter[k];
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Plan a `.where`. Returns a uniform shape that the QueryBuilder consumes.
 *
 * Shape:
 *   {
 *     useIndex: boolean,         // true iff a secondary index covers ≥1 field
 *     candidateIds: Set|null,    // set of $IDs from the index, if useIndex
 *     residualFilter: Function   // post-hydration JS filter; identity when no filter
 *   }
 *
 * Callers MUST handle both the index-hit (bounded hydration of the candidate
 * set) and the index-miss (fall back to full-collection enumeration).
 *
 * @class QueryPlanner
 */
export class QueryPlanner {
  /**
   * @param {Object} registry - Schema registry (for secondaryIndexManager)
   */
  constructor(registry) {
    this._registry = registry;
  }

  /**
   * Produce an execution plan for a `.where(filter)` against a collection.
   *
   * @param {string} collection
   * @param {Object|Function|null|undefined} filter
   * @returns {{useIndex:boolean, candidateIds:Set<string>|null, residualFilter:Function}}
   */
  planWhere(collection, filter) {
    // No filter, no index: residualFilter is null (identity — caller skips it).
    if (!filter) {
      return { useIndex: false, candidateIds: null, residualFilter: null };
    }
    // Function filters can't be analyzed structurally — fall back to scan
    // and run the function as the residual. Future improvement: accept a
    // compiled-filter object that exposes fields to the planner.
    if (typeof filter === 'function') return { useIndex: false, candidateIds: null, residualFilter: filter };
    if (typeof filter !== 'object') {
      throw new Error(`QueryPlanner: unsupported filter type ${typeof filter}`);
    }
    const mgr = this._registry.secondaryIndexManager?.();
    if (!mgr) {
      return { useIndex: false, candidateIds: null, residualFilter: compileFilter(filter) };
    }
    const result = mgr.candidatesFor(collection, filter);
    if (!result) {
      return { useIndex: false, candidateIds: null, residualFilter: compileFilter(filter) };
    }
    const residual = stripCovered(filter, result.covered);
    return {
      useIndex: true,
      candidateIds: new Set(result.ids),
      residualFilter: residual ? compileFilter(residual) : null
    };
  }
}

export default QueryPlanner;
