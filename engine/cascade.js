/**
 * @file Schema-scoped cancellation cascade — the §10 NON-NEGOTIABLE.
 *
 * Per spec §2.8 and §10, cascade is a bulk-delete primitive that:
 *   - Operates only on collections that declared a field with the matching
 *     `cascadeOn: '{scope}'` option in the schema (the two-store invariant
 *     V8 §3.6.0 requires that knowledge collections, which omit the flag,
 *     are invisible to memory-scope cascades).
 *   - Goes through `db.del.{collection}(id)` for each match so middleware
 *     keeps the vector / graph / secondary indexes in sync automatically.
 *   - Is idempotent: re-running the same cascade is a no-op.
 *   - Returns `{deleted, byCollection}` so callers can audit what happened.
 *
 * Transaction interaction:
 *   Cascade DOES NOT manage transactions. Callers compose the routine with
 *   their own rec/fin/nop semantics — typically `db.nop()` to discard any
 *   in-flight session writes followed by `db.cascade.session(id)` to clean
 *   up committed state. Pass `{ atomic: true }` to wrap the cascade in its
 *   own internal transaction so a failure mid-cascade rolls back. Pass
 *   `{ txnId: null }` to bypass the active transaction during cascade
 *   (deletes hit committed state directly).
 */

/**
 * Build the db.cascade namespace for a public db interface.
 *
 * @param {Object} ctx
 * @param {Object} ctx.registry - Schema registry (for cascadeEntriesFor)
 * @param {Function} ctx.getDb - Lazy db reference (so del.{collection} is reachable)
 * @returns {Object} cascade — Proxy with .session/.byField (extensible to other scopes)
 */
export function createCascade({ registry, getDb }) {
  /**
   * Run a cascade given a scope name, the scope id value, and options.
   * Iterates the registry's cascade entries for the scope, finds matching
   * docs in each collection, and deletes them through db.del.
   *
   * @param {string} scope - e.g. 'session'
   * @param {string} id - Scope value to match (e.g. 'SESS_abc123')
   * @param {Object} [opts]
   * @param {boolean} [opts.atomic=false] - Wrap in an internal txn
   * @param {string|null} [opts.txnId] - Pass null to bypass active txn
   * @returns {Promise<{deleted:number, byCollection:Object}>}
   */
  async function cascadeScope(scope, id, opts = {}) {
    const entries = registry.cascadeEntriesFor(scope);
    if (entries.length === 0) {
      return { deleted: 0, byCollection: {} };
    }
    return runCascade({
      entries,
      filterFor: (entry) => ({ [entry.field]: id }),
      opts,
      getDb
    });
  }

  /**
   * Explicit cascade — caller names the collections and the filter.
   * Used as an escape hatch when the schema doesn't have cascadeOn flags
   * or the caller wants to delete by some other criterion.
   *
   * @param {Object} args
   * @param {Array<string>} args.collections
   * @param {Object} args.filter
   * @param {Object} [args.opts]
   * @returns {Promise<{deleted:number, byCollection:Object}>}
   */
  async function cascadeByField(args) {
    if (!args || !Array.isArray(args.collections) || !args.filter) {
      throw new Error(
        'cascade.byField: requires { collections: [...], filter: {...} }'
      );
    }
    const entries = args.collections.map(collection => ({ collection }));
    return runCascade({
      entries,
      filterFor: () => args.filter,
      opts: args.opts || {},
      getDb
    });
  }

  // Build the public surface as a Proxy so db.cascade.{scope}(id) routes
  // dynamically without enumerating scopes up front. .byField is a fixed
  // method exposed at construction time.
  const cascade = new Proxy({ byField: cascadeByField }, {
    /**
     * Property-access trap: every property other than the fixed `byField`
     * is treated as a scope name. Returns a callable that runs the cascade
     * for that scope.
     * @param {Object} target
     * @param {string|symbol} prop
     * @returns {Function|undefined}
     */
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'byField') return target.byField;
      return (id, opts) => cascadeScope(prop, id, opts);
    }
  });
  return cascade;
}

/**
 * Shared cascade runner — iterates the entries, evaluates each filter,
 * and deletes matching docs through db.del. Counts and groups results.
 *
 * @param {Object} args
 * @param {Array<{collection:string, field?:string}>} args.entries
 * @param {Function} args.filterFor - entry → filter object for that collection
 * @param {Object} args.opts - Cascade options ({atomic, txnId})
 * @param {Function} args.getDb - Lazy db accessor
 * @returns {Promise<{deleted:number, byCollection:Object}>}
 */
async function runCascade({ entries, filterFor, opts, getDb }) {
  const db = getDb();
  let txnOwned = false;
  if (opts.atomic) {
    db.rec();
    txnOwned = true;
  }
  const byCollection = {};
  let deleted = 0;
  try {
    for (const entry of entries) {
      const filter = filterFor(entry);
      const matchedIds = await collectMatchingIds(db, entry.collection, filter, opts);
      for (const id of matchedIds) {
        // db.del.{collection}(id) goes through middleware so vector +
        // graph + secondary indexes all sync as part of each delete.
        if ('txnId' in opts) {
          await db.del[entry.collection](id, undefined, { txnId: opts.txnId });
        } else {
          await db.del[entry.collection](id);
        }
      }
      byCollection[entry.collection] = matchedIds.length;
      deleted += matchedIds.length;
    }
    if (txnOwned) await db.fin();
  } catch (err) {
    if (txnOwned) {
      try { await db.nop(); } catch (_) { /* nop best-effort */ }
    }
    throw err;
  }
  return { deleted, byCollection };
}

/**
 * Find $IDs of docs matching a filter on a collection. Uses the existing
 * group-get path so the lookup respects schema, indexes, and any active
 * transaction context (subject to opts.txnId override).
 *
 * @param {Object} db
 * @param {string} collection
 * @param {Object} filter
 * @param {Object} opts - May include txnId override
 * @returns {Promise<Array<string>>} matching $IDs
 */
async function collectMatchingIds(db, collection, filter, opts) {
  const groupKey = `${collection}S`;
  // The legacy callable form takes (filter, opts) — opts.txnId === null
  // forces committed-only enumeration; omitting opts uses the active txn.
  const docs = 'txnId' in opts
    ? await db.get[groupKey](filter, { txnId: opts.txnId })
    : await db.get[groupKey](filter);
  return docs.filter(Boolean).map(d => d.$ID);
}

export default createCascade;
