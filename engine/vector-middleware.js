/**
 * @file Middleware that keeps schema-driven indexes (vector + secondary) in
 * sync with add/set/del operations and enforces schemas registered through
 * the schema registry.
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
 *   - For 'set' and 'del': the pre-update document is captured BEFORE next()
 *     because secondary indexes need the OLD field values to remove the
 *     correct compound key when the field changes. Cost: one extra read per
 *     write to a collection with secondary indexes.
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

    // PRE: capture the pre-state for set/del so secondary-index removal can
    // target the OLD compound keys. Vector index doesn't need this (its
    // remove is keyed by $ID, not field values).
    let preDoc = null;
    const idxMgr = registry.secondaryIndexManager?.();
    const hasSecondary = idxMgr && hasIndexesFor(idxMgr, ctx.type);
    if (hasSecondary && (ctx.operation === 'set' || ctx.operation === 'del')) {
      const target = ctx.args[0];
      const targetId = typeof target === 'string' ? target : target?.$ID;
      if (targetId) {
        try {
          preDoc = await ctx.db.get[ctx.type.replace(/S$/, '')](targetId);
          if (preDoc && preDoc.toObject) preDoc = preDoc.toObject();
        } catch (_) {
          // Pre-fetch failure is not fatal — the secondary-index sync will
          // be a best-effort skip on this op rather than blocking the write.
          preDoc = null;
        }
      }
    }

    await next();

    // POST: sync the vector index.
    const fieldName = registry.vectorFieldOf(ctx.type);
    const vIndex = fieldName ? registry.vectorIndex(ctx.type) : null;
    if (vIndex) {
      if (ctx.operation === 'add' || ctx.operation === 'set') {
        const entity = ctx.result;
        if (entity && entity.$ID && Array.isArray(entity[fieldName])) {
          vIndex.add(entity.$ID, entity[fieldName]);
        }
      } else if (ctx.operation === 'del') {
        const id = typeof ctx.args[0] === 'string' ? ctx.args[0]
                 : (ctx.args[0] && ctx.args[0].$ID);
        if (id) vIndex.remove(id);
      }
    }

    // POST: sync secondary indexes.
    if (hasSecondary) {
      if (ctx.operation === 'add') {
        const entity = ctx.result;
        if (entity && entity.$ID) idxMgr.insert(ctx.type, entity);
      } else if (ctx.operation === 'set') {
        const entity = ctx.result;
        if (entity && entity.$ID) {
          if (preDoc) idxMgr.update(ctx.type, preDoc, entity);
          else idxMgr.insert(ctx.type, entity);
        }
      } else if (ctx.operation === 'del') {
        if (preDoc && preDoc.$ID) idxMgr.remove(ctx.type, preDoc);
      }
    }
  };
}

/**
 * Probe whether the secondary-index manager has any indexes for a given
 * collection. Used to short-circuit the pre-fetch path when no indexes
 * apply.
 * @param {Object} mgr - SecondaryIndexManager
 * @param {string} collection
 * @returns {boolean}
 */
function hasIndexesFor(mgr, collection) {
  for (const [c, _specs] of mgr.collections()) {
    if (c === collection) return true;
  }
  return false;
}

export default vectorIndexMiddleware;
