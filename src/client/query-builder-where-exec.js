/**
 * @file `.where`-only execution path for QueryBuilder (no vector / match).
 *
 * Extracted to keep query-builder.js under the 260-source-line pre-commit gate.
 * Index-bounded vs full-scan paths mirror the planner output from
 * QueryPlanner.planWhere.
 */

/**
 * Run a chain with no .near / .match / .combine — pure attribute filtering.
 *
 * @param {Object} ctx - QueryBuilder _ctx
 * @param {Object} plan - From QueryPlanner.planWhere
 * @param {number|undefined} limit
 * @returns {Promise<Array<Object>>}
 */
export async function executeWherePlan(ctx, plan, limit) {
  const { collection, wrapper } = ctx;
  if (plan.useIndex) {
    const ids = [...plan.candidateIds];
    const docs = await Promise.all(ids.map(id => wrapper.get(null, id)));
    const filtered = plan.residualFilter
      ? docs.filter(doc => doc && plan.residualFilter(doc))
      : docs.filter(Boolean);
    return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
  }
  const all = await wrapper.get(`${collection}S`);
  const filtered = plan.residualFilter ? all.filter(plan.residualFilter) : all;
  return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
}
