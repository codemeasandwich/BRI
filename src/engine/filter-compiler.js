/**
 * @file Shared filter compiler for .where / .having / planner residuals.
 *
 * Compiles a Bri object filter into a JS predicate. Operator support per
 * spec §2.2: equality (default), $ne, $gt, $gte, $lt, $lte, $in, $exists.
 *
 * Single source of truth so .where, .having, and the QueryPlanner's
 * residual filter all agree on semantics — divergence between any two
 * would produce silently-different results for the same filter shape.
 *
 * Why a free module (not a method on QueryBuilder):
 *   QueryPlanner consumes this without importing QueryBuilder, and the
 *   GroupedQueryBuilder (introduced for UC-X3) needs the same compiler.
 *   A free function with no class state stays composable.
 */

/**
 * Compile a per-field operator clause (e.g. {$gte: 5, $lt: 10}) into a
 * predicate over a single field value. Multiple operators in one clause
 * must all hold (AND).
 *
 * @param {Object} clause - {operator: value, ...}
 * @returns {(fieldValue:*)=>boolean}
 */
function compileClause(clause) {
  const checks = [];
  for (const [op, val] of Object.entries(clause)) {
    switch (op) {
      case '$ne':
        checks.push(v => v !== val);
        break;
      case '$gt':
        checks.push(v => v > val);
        break;
      case '$gte':
        checks.push(v => v >= val);
        break;
      case '$lt':
        checks.push(v => v < val);
        break;
      case '$lte':
        checks.push(v => v <= val);
        break;
      case '$in':
        if (!Array.isArray(val)) {
          throw new Error(`Filter operator $in expects an array; got ${typeof val}`);
        }
        checks.push(v => val.includes(v));
        break;
      case '$exists': {
        const want = !!val;
        checks.push(v => (v !== undefined && v !== null) === want);
        break;
      }
      default:
        throw new Error(`Unsupported filter operator: ${op}`);
    }
  }
  return (v) => {
    for (const check of checks) {
      if (!check(v)) return false;
    }
    return true;
  };
}

/**
 * Detect whether a value is an operator clause (a plain object whose keys
 * are all `$`-prefixed). Plain values and arrays are not clauses.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isClause(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every(k => k.startsWith('$'));
}

/**
 * Compile an object filter into a JS predicate over documents. The filter's
 * keys are field names. Each value is either a literal (equality) or an
 * operator clause (`{$gte: N}` etc.). Multiple keys AND together.
 *
 * Function filters pass through unchanged. null/undefined returns the
 * identity-true predicate.
 *
 * @param {Object|Function|null|undefined} filter
 * @returns {(doc:Object)=>boolean}
 */
export function compileFilter(filter) {
  if (filter === undefined || filter === null) return () => true;
  if (typeof filter === 'function') return filter;
  if (typeof filter !== 'object') {
    throw new Error(`compileFilter: unsupported filter type ${typeof filter}`);
  }
  // Compile each field into a per-field predicate up front so the document
  // walk doesn't reinterpret the filter on every call.
  const fieldChecks = Object.entries(filter).map(([field, value]) => {
    if (isClause(value)) {
      const clausePred = compileClause(value);
      return (doc) => clausePred(doc[field]);
    }
    return (doc) => doc[field] === value;
  });
  return (doc) => {
    if (!doc) return false;
    for (const check of fieldChecks) {
      if (!check(doc)) return false;
    }
    return true;
  };
}

export default compileFilter;
