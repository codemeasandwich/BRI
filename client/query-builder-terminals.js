/**
 * @file Terminal operations for QueryBuilder (.first, .count, .distinct).
 *
 * Extracted so query-builder.js stays under the 260-source-line gate. Each
 * function receives the builder instance (duck-typed) and calls public .toArray().
 */

import { BriQueryError } from '../engine/errors.js';

/**
 * @param {{ toArray: () => Promise<Array<Object>> }} qb
 * @returns {Promise<Object|null>}
 */
export async function queryBuilderFirst(qb) {
  const arr = await qb.toArray();
  return arr.length > 0 ? arr[0] : null;
}

/**
 * @param {{ toArray: () => Promise<Array<Object>>, _state: { near?: unknown } }} qb
 * @returns {Promise<number>}
 */
export async function queryBuilderCount(qb) {
  if (qb._state.near) {
    throw new BriQueryError({
      code: 'COUNT_NEAR_UNSUPPORTED',
      message:
        'QueryBuilder.count() does not compose with .near. Run the .near query and inspect length, or use .where alone for a counted scan.',
      details: {}
    });
  }
  const arr = await qb.toArray();
  return arr.length;
}

/**
 * @param {{ toArray: () => Promise<Array<Object>>, _state: { near?: unknown } }} qb
 * @param {string} field
 * @returns {Promise<Array>}
 */
export async function queryBuilderDistinct(qb, field) {
  if (qb._state.near) {
    throw new BriQueryError({
      code: 'DISTINCT_NEAR_UNSUPPORTED',
      message:
        'QueryBuilder.distinct() does not compose with .near. Run the .near query and dedupe the field client-side.',
      details: { field }
    });
  }
  const arr = await qb.toArray();
  const seen = new Set();
  const out = [];
  for (const doc of arr) {
    if (!doc) continue;
    const v = doc[field];
    if (v === undefined || v === null) continue;
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
