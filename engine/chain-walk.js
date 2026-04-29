/**
 * @file Self-referential ref chain walker — `entity.chain.{field}` per
 * spec §2.5 / UC-G4.
 *
 * Walk a self-ref field forward (or backward, depending on which field
 * the user accesses) from a seed entity through repeated single-hop
 * lookups. Termination conditions:
 *   - the field's value is null/undefined (end of chain)
 *   - the next id has already been visited (cycle detected)
 *   - chain length reaches maxDepth (truncation)
 *
 * Output:
 *   - flat Array<entity> on clean termination at null/undefined
 *   - { chain: Array<entity>, cycleDetected: true } on cycle
 *   - { chain: Array<entity>, truncated: true } on maxDepth with more chain
 *     available; reaching maxDepth at exactly the chain end returns the
 *     flat array with no flag (the user got everything they could)
 *
 * Cross-collection refs are NOT followed by this walker — `.chain.{field}`
 * is for self-referential fields only. The `makeChainProxy` validator
 * rejects cross-collection access at property-access time with an error
 * that recommends `.and.{field}` (the existing single-hop ref proxy).
 *
 * @implements UC-G4
 */

import { BriProxyError, CHAIN_CROSSES_COLLECTION } from './errors.js';

/**
 * Build the ChainProxy returned for `entity.chain`. Property accesses are
 * field names; each one returns a callable+thenable walker bound to the
 * named field. The accessor is callable with `{maxDepth}` for explicit
 * cap and thenable for default behavior.
 *
 * @param {Object} args
 * @param {Object} args.target - Seed entity body
 * @param {Object} args.registry - Schema registry (for ref-field validation)
 * @param {Object} args.wrapper - Engine wrapper (for hop hydration)
 * @param {string} args.subjectCollection - Collection of the seed
 * @returns {Proxy}
 */
export function makeChainProxy({ target, registry, wrapper, subjectCollection }) {
  return new Proxy({}, {
    /**
     * @param {Object} _t
     * @param {string|symbol} field
     * @returns {Function|Object|undefined}
     */
    get(_t, field) {
      if (typeof field === 'symbol') return undefined;
      const schema = registry.get(subjectCollection);
      const decl = schema && schema[field];
      if (!decl || decl.type !== 'ref') {
        const error = new BriProxyError({
          code: CHAIN_CROSSES_COLLECTION,
          message: `entity.chain.${field}: '${field}' is not a 'ref' field on '${subjectCollection}'. Chain walks require self-ref fields.`,
          details: { collection: subjectCollection, field }
        });
        return rejectingThenable(error);
      }
      if (decl.to !== subjectCollection) {
        const error = new BriProxyError({
          code: CHAIN_CROSSES_COLLECTION,
          message: `entity.chain.${field}: '${field}' refs '${decl.to}', not the same collection '${subjectCollection}'. Chain walks cross collections — use a single-hop .and.${field} instead.`,
          details: { collection: subjectCollection, field, refTo: decl.to }
        });
        return rejectingThenable(error);
      }
      /**
       * Callable form — bind the maxDepth override.
       * @param {Object} [opts]
       * @param {number} [opts.maxDepth]
       * @returns {Promise}
       */
      const walker = (opts = {}) =>
        walkChain({ target, field, wrapper, maxDepth: opts.maxDepth });
      walker.then = (onResolve, onReject) =>
        walkChain({ target, field, wrapper }).then(onResolve, onReject);
      return walker;
    }
  });
}

/**
 * Build a thenable that immediately rejects with the given error. Used by
 * makeChainProxy when a field validation fails — the rejection surfaces
 * on `await entity.chain.{field}` without throwing during property access
 * (which would break the proxy contract for field discovery).
 *
 * @param {Error} error
 * @returns {Object} thenable
 */
function rejectingThenable(error) {
  return {
    /**
     * @param {Function} _onResolve
     * @param {Function} onReject
     * @returns {Promise}
     */
    then: (_onResolve, onReject) => Promise.reject(error).catch(onReject)
  };
}

/**
 * Walk a self-referential ref chain from a seed entity.
 *
 * @param {Object} args
 * @param {Object} args.target - Seed entity body (with $ID and the ref field)
 * @param {string} args.field - Self-ref field name
 * @param {Object} args.wrapper - Engine wrapper (for hop hydration)
 * @param {number} [args.maxDepth=10000] - Cap on total chain length (incl. seed)
 * @returns {Promise<Array<Object>|Object>} flat array on clean termination,
 *   or {chain, cycleDetected:true} on cycle, or {chain, truncated:true} on
 *   maxDepth-with-more-available
 */
export async function walkChain({ target, field, wrapper, maxDepth = 10000 }) {
  const visited = new Set([target.$ID]);
  const chain = [target];
  let current = target;
  let cycleDetected = false;
  // maxDepth caps the total chain length (seed + hops) — spec example
  // shows the user passes a number they expect as the result-array cap.
  while (chain.length < maxDepth) {
    const nextId = current[field];
    if (nextId === undefined || nextId === null) return chain;
    if (visited.has(nextId)) {
      cycleDetected = true;
      break;
    }
    const next = await wrapper.get(null, nextId);
    if (!next) return chain;
    visited.add(nextId);
    chain.push(next);
    current = next;
  }
  if (cycleDetected) return { chain, cycleDetected: true };
  // Hit maxDepth. Only flag truncated if the chain could have continued.
  if (current[field] !== undefined && current[field] !== null) {
    return { chain, truncated: true };
  }
  return chain;
}
