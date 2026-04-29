/**
 * @file GroupedQueryBuilder — produced by `QueryBuilder.groupBy(field)`.
 *
 * Supports two terminals — .count() and .sum(field) — each of which
 * returns either a thenable that resolves to the aggregated rows, or a
 * `.having(filter)` chain that applies the same operator-aware filter
 * compiler to the aggregated row shape (`{ <groupField>: value, count|sum: number }`).
 *
 * Why a separate class (vs. methods on QueryBuilder): the aggregation
 * result shape differs from the standard entity-row shape, so distinct
 * chain methods avoid confusing the two. The grouped builder is itself
 * thenable — `await builder.groupBy('x').count()` works without an
 * explicit terminal.
 *
 * @implements UC-X3 (groupBy, sum, having)
 */

import { compileFilter } from '../engine/filter-compiler.js';

/**
 * Grouped query builder.
 *
 * @class GroupedQueryBuilder
 */
export class GroupedQueryBuilder {
  /**
   * @param {Object} parent - Source QueryBuilder (filter + collection state)
   * @param {string} field - Field name to group on
   * @param {Object} [state] - Internal accumulator from chain methods
   */
  constructor(parent, field, state = {}) {
    this._parent = parent;
    this._field = field;
    this._state = state;
  }

  /**
   * Branch the grouped chain.
   * @param {Object} patch
   * @returns {GroupedQueryBuilder}
   * @private
   */
  _next(patch) {
    return new GroupedQueryBuilder(
      this._parent, this._field, { ...this._state, ...patch }
    );
  }

  /**
   * Count rows per group. Without subsequent .having, the
   * GroupedQueryBuilder becomes thenable and resolves to grouped rows.
   * @returns {GroupedQueryBuilder}
   */
  count() {
    return this._next({ agg: { kind: 'count' } });
  }

  /**
   * Sum a numeric field per group.
   * @param {string} sumField
   * @returns {GroupedQueryBuilder}
   */
  sum(sumField) {
    return this._next({ agg: { kind: 'sum', field: sumField } });
  }

  /**
   * Apply a post-aggregation filter to the rows produced by .count or
   * .sum. Filter shape matches .where; uses the shared compileFilter so
   * $gte etc. work on the synthesized 'count'/'sum' field.
   * @param {Object} filter
   * @returns {GroupedQueryBuilder}
   */
  having(filter) {
    return this._next({ having: filter });
  }

  /**
   * Execute the grouped query.
   * @returns {Promise<Array<Object>>} aggregated rows
   */
  async toArray() {
    const docs = await this._parent.toArray();
    const groups = new Map();
    for (const doc of docs) {
      if (!doc) continue;
      const key = doc[this._field];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }
    const agg = this._state.agg || { kind: 'count' };
    let rows = [];
    for (const [key, docsInGroup] of groups) {
      const row = { [this._field]: key };
      if (agg.kind === 'sum') {
        let sum = 0;
        for (const d of docsInGroup) {
          const v = d[agg.field];
          if (typeof v === 'number') sum += v;
        }
        row.sum = sum;
      } else {
        row.count = docsInGroup.length;
      }
      rows.push(row);
    }
    if (this._state.having) {
      const pred = compileFilter(this._state.having);
      rows = rows.filter(pred);
    }
    return rows;
  }

  /**
   * Thenable.
   * @param {Function} onResolve
   * @param {Function} onReject
   * @returns {Promise<Array>}
   */
  then(onResolve, onReject) {
    return this.toArray().then(onResolve, onReject);
  }
}

export default GroupedQueryBuilder;
