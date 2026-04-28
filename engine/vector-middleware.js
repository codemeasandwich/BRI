/**
 * @file Middleware that keeps the per-collection VectorIndex in sync with
 * add/set/del operations and enforces schemas registered through the
 * schema registry.
 *
 * Why this lives in engine (not client):
 *   The middleware reads the same registry the engine consults internally
 *   for validation and index lookup. Co-locating it with the registry and
 *   index modules keeps the schema-driven feature surface in one place;
 *   client/proxy.js only needs to wire it into the runner.
 *
 * Order constraints (binding):
 *   - Validation runs BEFORE next() — invalid writes must short-circuit
 *     before any storage mutation occurs.
 *   - Index sync runs AFTER next() — add/set need ctx.result.$ID assigned
 *     by the engine before the index can record the slot.
 */

/**
 * Build the vector + schema sync middleware bound to a registry.
 *
 * @param {Object} registry - SchemaRegistry instance from createSchemaRegistry()
 * @returns {Function} middleware compatible with createMiddleware().use()
 */
export function vectorIndexMiddleware(registry) {
  /**
   * The actual middleware function. See file docblock for ordering rules.
   *
   * @param {Object} ctx - Middleware context (operation, type, args, result)
   * @param {Function} next - Continue chain; awaiting it runs the operation
   * @returns {Promise<void>}
   */
  return async function vectorMw(ctx, next) {
    // PRE: validate the body against any registered schema before persisting.
    // Throws on validation error so the engine never sees the invalid write.
    if (ctx.operation === 'add' || ctx.operation === 'set') {
      const data = ctx.args[0];
      if (data && typeof data === 'object') {
        const err = registry.validate(ctx.type, data);
        if (err) {
          throw new Error(`Validation failed for ${ctx.type}: ${err}`);
        }
      }
    }

    await next();

    // POST: sync the vector index. ctx.result holds the persisted entity for
    // add/set. For del we use the supplied $ID from args.
    const fieldName = registry.vectorFieldOf(ctx.type);
    if (!fieldName) return; // collection has no vector field; nothing to do
    const index = registry.vectorIndex(ctx.type);
    if (!index) return;

    if (ctx.operation === 'add' || ctx.operation === 'set') {
      const entity = ctx.result;
      if (entity && entity.$ID && Array.isArray(entity[fieldName])) {
        index.add(entity.$ID, entity[fieldName]);
      }
    } else if (ctx.operation === 'del') {
      const id = typeof ctx.args[0] === 'string' ? ctx.args[0]
               : (ctx.args[0] && ctx.args[0].$ID);
      if (id) index.remove(id);
    }
  };
}

export default vectorIndexMiddleware;
