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
    // The validator throws BriValidationError directly — the engine never
    // sees an invalid write because the typed error short-circuits the chain.
    if (ctx.operation === 'add' || ctx.operation === 'set') {
      const data = ctx.args[0];
      if (data && typeof data === 'object') {
        registry.validate(ctx.type, data);
      }
    }

    // PRE: capture the pre-state for set/del so secondary-index removal
    // and graph-index cleanup can target the OLD field values. Vector
    // index doesn't need this (its remove is keyed by $ID, not values).
    let preDoc = null;
    const idxMgr = registry.secondaryIndexManager?.();
    const hasSecondary = idxMgr && hasIndexesFor(idxMgr, ctx.type);
    const isEdge = !!registry.edgeSpec?.(ctx.type);
    const needsPreFetch = (hasSecondary || isEdge) &&
                          (ctx.operation === 'set' || ctx.operation === 'del');
    // Pre-fetch keyed by resolved $ID — when target resolves to empty (del of
    // malformed body, etc.), skip the lookup; preDoc stays null.
    if (needsPreFetch) {
      const target = ctx.args[0];
      const targetId = typeof target === 'string' ? target : target?.$ID;
      try {
        preDoc = targetId
          ? await ctx.db.get[ctx.type.replace(/S$/, '')](targetId)
          : null;
        if (preDoc && preDoc.toObject) preDoc = preDoc.toObject();
      } catch (_) {
        // Pre-fetch failure is not fatal — the secondary-index sync will
        // be a best-effort skip on this op rather than blocking the write.
        preDoc = null;
      }
    }

    await next();

    // POST: sync the vector index. When a txnId is in scope, route through
    // the staged path so the committed buffer stays untouched until fin.
    // Outside a txn, fall through to the regular add/remove path.
    const fieldName = registry.vectorFieldOf(ctx.type);
    const vIndex = fieldName ? registry.vectorIndex(ctx.type) : null;
    if (vIndex) {
      const txnId = ctx.opts.txnId;
      if (ctx.operation === 'add' || ctx.operation === 'set') {
        const entity = ctx.result;
        if (entity && entity.$ID && Array.isArray(entity[fieldName])) {
          if (txnId) vIndex.addStaged(txnId, entity.$ID, entity[fieldName]);
          else vIndex.add(entity.$ID, entity[fieldName]);
        }
      } else if (ctx.operation === 'del') {
        const id = typeof ctx.args[0] === 'string' ? ctx.args[0]
                 : (ctx.args[0] && ctx.args[0].$ID);
        if (id) {
          if (txnId) vIndex.removeStaged(txnId, id);
          else vIndex.remove(id);
        }
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

    // POST: sync the graph index for edge collections. The collection has
    // an edge spec iff its schema declared $edge; non-edge collections
    // are no-ops here. Insert on add, replace on set (remove old then
    // insert new), remove on delete.
    const graph = registry.graphIndex();
    const edgeSpec = registry.edgeSpec(ctx.type);
    if (edgeSpec) {
      if (ctx.operation === 'add') {
        const entity = ctx.result;
        if (entity && entity.$ID) graph.insertEdge(ctx.type, entity);
      } else if (ctx.operation === 'set') {
        const entity = ctx.result;
        if (entity && entity.$ID) {
          if (preDoc) graph.removeEdge(ctx.type, preDoc);
          graph.insertEdge(ctx.type, entity);
        }
      } else if (ctx.operation === 'del') {
        if (preDoc && preDoc.$ID) graph.removeEdge(ctx.type, preDoc);
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
