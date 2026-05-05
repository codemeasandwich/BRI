/**
 * @file Middleware that keeps schema-driven indexes (vector + secondary +
 * graph + canonical-pair) in sync with add/set/del operations and enforces
 * schemas registered through the schema registry.
 *
 * Why this lives in engine (not client):
 *   The middleware reads the same registry the engine consults internally
 *   for validation and index lookup. Co-locating it with the registry and
 *   index modules keeps the schema-driven feature surface in one place;
 *   client/proxy.js only needs to wire it into the runner.
 *
 * Order constraints (binding):
 *   - Schema validation runs BEFORE next() — invalid writes must short-
 *     circuit before any storage mutation occurs.
 *   - UC-G3 canonical-pair uniqueness check (for `$edge.unique && symmetric`
 *     collections) ALSO runs BEFORE next(). Pre-validating duplicates is
 *     critical: post-write detection would require orphan cleanup of a doc
 *     the engine already wrote, and any failure between write and cleanup
 *     leaves a duplicate. Pre-validation matches the existing schema-
 *     validation pattern at the top of this middleware and short-circuits
 *     uniformly.
 *   - For 'set' and 'del': the pre-update document is captured BEFORE next()
 *     because secondary indexes need the OLD field values to remove the
 *     correct compound key when the field changes. Cost: one extra read per
 *     write to a collection with secondary indexes.
 *   - Index sync runs AFTER next() — add/set need ctx.result.$ID assigned
 *     by the engine before the index can record the slot.
 *
 * Canonical-pair shadow doc:
 *   When the collection needs a canonical-pair index (registry.needsCanonicalPair),
 *   we project the synthetic `__edgePair` field onto a SHADOW copy of the doc
 *   for the secondary-index manager to read. The doc's persisted body is
 *   untouched; the synthetic key lives only in the index. Why a shadow copy
 *   instead of mutating: secondary-index keys are derived from `doc[field]`
 *   in SecondaryIndexManager.{insert,update,remove}, so the synthetic field
 *   has to appear on the object the manager sees — but it must not appear
 *   on the persisted body (would round-trip through validation, JSON, etc.
 *   and be a leaking implementation detail). The shadow is throwaway.
 *
 * Consumed by: client/proxy.js (registers via `db.use(vectorIndexMiddleware(registry))`).
 * Consumes: schema-registry (validate, vectorIndex/Field, secondaryIndexManager,
 *           graphIndex, edgeSpec, needsCanonicalPair, canonicalPairKey),
 *           errors.js (BriValidationError + EDGE_PAIR_NOT_UNIQUE).
 */

import { BriValidationError, EDGE_PAIR_NOT_UNIQUE } from './errors.js';

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
    // UC-G3 — collections that declared `$edge.unique && symmetric` need
    // their canonical-pair index synced and (for add / pair-changing set)
    // a uniqueness pre-check.
    const isCanonicalPair = !!registry.needsCanonicalPair?.(ctx.type);
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

    // UC-G3 PRE-WRITE UNIQUENESS CHECK
    // Pre-empt orphan cleanup by validating uniqueness BEFORE storage
    // mutation. If an edge document targeting this canonical pair already
    // exists with a different $ID, throw before next() — matching the
    // schema-validation pattern at the top of this middleware.
    //
    // Why pre-validate (not post-validate via a unique-violation rollback):
    //   - Post-validation requires reverting a doc the engine already
    //     wrote; any failure between write and rollback leaves a duplicate.
    //   - Pre-validation gives a clean throw-with-no-side-effects that
    //     callers can catch and branch on (e.g. "already exists, increment
    //     instead").
    //
    // Skip for `set` when the pair did not change — it's the same doc
    // (preDoc.$ID === target.$ID) and the index already maps the key to
    // that $ID. The `idxMgr.update()` call later in this middleware
    // handles a pair-changing set by removing the old key first.
    if (isCanonicalPair && (ctx.operation === 'add' || ctx.operation === 'set')) {
      const candidateBody = ctx.args[0];
      if (candidateBody && typeof candidateBody === 'object') {
        const pairKey = registry.canonicalPairKey(ctx.type, candidateBody);
        if (pairKey) {
          // Look up the existing $ID(s) for this canonical pair, if any.
          const candidates = idxMgr.candidatesFor(ctx.type, { __edgePair: pairKey });
          const existingIds = candidates ? candidates.ids : [];
          // For set: ignore self-matches (the doc updating itself).
          const selfId = ctx.operation === 'set'
            ? (typeof candidateBody === 'string' ? candidateBody : candidateBody.$ID)
            : null;
          const conflict = existingIds.find(id => id !== selfId);
          if (conflict) {
            throw new BriValidationError({
              code: EDGE_PAIR_NOT_UNIQUE,
              message:
                `Edge collection '${ctx.type}' is declared $edge.unique with $edge.symmetric — ` +
                `the unordered pair {${pairKey[0]}, ${pairKey[1]}} already maps to existing ` +
                `edge $ID '${conflict}'. To update the existing edge, fetch it first and use ` +
                `db.set; to enforce only-one-per-pair semantics, catch EDGE_PAIR_NOT_UNIQUE ` +
                `at the call site and branch on the existing $ID.`,
              details: {
                collection: ctx.type, pairKey,
                existingId: conflict,
                operation: ctx.operation
              }
            });
          }
        }
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
    //
    // For canonical-pair collections (UC-G3), project the synthetic
    // `__edgePair` field onto a SHADOW copy of the doc passed to the
    // index manager. The shadow lives only for the duration of the
    // insert/update/remove call; the persisted document body never carries
    // `__edgePair`. SecondaryIndexManager keys each spec by reading
    // doc[field], so the synthetic key has to appear on the object the
    // manager sees — but it must not appear on the doc on disk (would
    // round-trip through validation, JSON, etc. and become a leaking
    // implementation detail).
    if (hasSecondary) {
      /**
       * Project __edgePair onto a SHADOW copy of an edge doc for the
       * SecondaryIndexManager. Returns the doc unchanged for non-
       * canonical-pair collections (the common case — no extra
       * allocation). Reactive entities are unwrapped via toObject() to
       * a POJO; POJOs are shallow-copied. The persisted body is never
       * mutated; the synthetic field lives only in the index.
       * @param {Object|undefined} doc
       * @returns {Object|undefined}
       */
      const projectShadow = (doc) => {
        if (!isCanonicalPair || !doc) return doc;
        const pairKey = registry.canonicalPairKey(ctx.type, doc);
        // No pair key (missing from/to fields) → no canonical-pair entry;
        // the manager will see no __edgePair and the [__edgePair] index
        // skips this doc cleanly.
        if (!pairKey) return doc;
        const body = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
        body.__edgePair = pairKey;
        return body;
      };

      if (ctx.operation === 'add') {
        const entity = ctx.result;
        if (entity && entity.$ID) idxMgr.insert(ctx.type, projectShadow(entity));
      } else if (ctx.operation === 'set') {
        const entity = ctx.result;
        if (entity && entity.$ID) {
          if (preDoc) idxMgr.update(ctx.type, projectShadow(preDoc), projectShadow(entity));
          else idxMgr.insert(ctx.type, projectShadow(entity));
        }
      } else if (ctx.operation === 'del') {
        if (preDoc && preDoc.$ID) idxMgr.remove(ctx.type, projectShadow(preDoc));
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
