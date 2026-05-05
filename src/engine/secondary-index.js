/**
 * @file Secondary indexes — declared per-collection compound indexes used to
 * bound .where lookups before they hit document bodies.
 *
 * Architecture:
 *   - SortedIndex holds (sortedKey, ids[]) entries; binary search resolves
 *     equality and range lookups in O(log n + matches).
 *   - SecondaryIndexManager owns one or more SortedIndex instances per
 *     collection (one per declared compound spec) and routes write/lookup
 *     calls.
 *   - Compound keys are JSON.stringify(values). Prefix matching exploits the
 *     lexicographic order of the JSON encoding: filter prefix `[v0]` finds
 *     all entries starting with `[v0,...]` via a range over [`[v0,]`, `[v0]￿`).
 *
 * Why a sorted-array B-tree-flavor (not a real B-tree):
 *   At v1 scale (≤10k docs/collection), array operations are dominated by
 *   binary search and a single Array.splice. Real B-trees pay off above ~100k
 *   per-index entries; until then the simpler structure is faster, has no
 *   pointer overhead, and serializes to a flat buffer trivially. v2 swaps in
 *   a real B-tree behind the same interface when persisted index size
 *   warrants it.
 *
 * Persistence:
 *   serialize() emits a JSON-friendly POJO so the snapshot can carry it
 *   alongside vectorIndices. The wire shape is intentionally human-readable
 *   for debugging — secondary indexes are always small (id strings, not
 *   float matrices), so binary packing buys nothing.
 *
 * @implements engine portion of UC-X1 / UC-V1 .where-prefilter path
 */

import { logTxnOp } from './secondary-index-txn.js';

/**
 * Compute the JSON-encoded compound key for a given list of field values.
 *
 * Why JSON.stringify: deterministic, lexicographic-safe encoding for arrays
 * of strings/numbers/null/booleans, which covers the v1 filter type space.
 * Object-valued fields are not currently supported as index fields and would
 * trip on key-ordering nondeterminism — flag at declare-time, not here.
 *
 * @param {Array<*>} values - One value per indexed field, in declaration order
 * @returns {string} canonical key suitable for sorted insertion / lookup
 */
function compoundKey(values) {
  return JSON.stringify(values);
}

/**
 * Detect whether a filter value is an operator clause (e.g. `{$gte: 5}`)
 * rather than a literal equality value. Operator clauses fall back to
 * residual filtering instead of index lookup.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isOperatorClause(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every(k => k.startsWith('$'));
}

/**
 * One sorted compound index — keys are JSON-encoded value tuples; values are
 * arrays of document $IDs. Multiple docs may share a key.
 */
class SortedIndex {
  /**
   * Construct an empty sorted compound index.
   *
   * Parallel-array storage: _keys[i] sorts ascending; _ids[i] is the array of
   * document $IDs that share that compound key. Entries whose ids[] becomes
   * empty are spliced out so the index never stores stale keys.
   */
  constructor() {
    this._keys = [];
    this._ids = [];
  }

  /**
   * Binary search for a key. Returns the index where the key is or would be
   * inserted (lo on hit; lo on miss). Caller checks _keys[lo] === key.
   *
   * @param {string} key
   * @returns {number} index in [0, length]
   * @private
   */
  _bsearch(key) {
    let lo = 0, hi = this._keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Insert a (key, id) pair. Idempotent if (key, id) already exists.
   *
   * @param {string} key - Canonical compound key
   * @param {string} id - Document $ID
   */
  insert(key, id) {
    const i = this._bsearch(key);
    if (i < this._keys.length && this._keys[i] === key) {
      const ids = this._ids[i];
      if (!ids.includes(id)) ids.push(id);
      return;
    }
    this._keys.splice(i, 0, key);
    this._ids.splice(i, 0, [id]);
  }

  /**
   * Remove a (key, id) pair. No-op if absent. Empty entries are spliced out.
   *
   * @param {string} key
   * @param {string} id
   */
  remove(key, id) {
    const i = this._bsearch(key);
    if (i >= this._keys.length || this._keys[i] !== key) return;
    const ids = this._ids[i];
    const j = ids.indexOf(id);
    if (j >= 0) ids.splice(j, 1);
    if (ids.length === 0) {
      this._keys.splice(i, 1);
      this._ids.splice(i, 1);
    }
  }

  /**
   * Exact-key lookup. Returns the array of ids (may be empty).
   *
   * @param {string} key
   * @returns {Array<string>}
   */
  lookup(key) {
    const i = this._bsearch(key);
    if (i < this._keys.length && this._keys[i] === key) {
      return this._ids[i].slice();
    }
    return [];
  }

  /**
   * Range lookup: ids whose key is in [lo, hi). Used for prefix matching
   * after a planner converts `{session: 'X'}` on a `[session, type]` index
   * into `[lo='["X"]', hi='["X"￿]')`.
   *
   * @param {string} lo - Inclusive lower bound
   * @param {string} hi - Exclusive upper bound
   * @returns {Array<string>}
   */
  range(lo, hi) {
    const start = this._bsearch(lo);
    const out = [];
    for (let i = start; i < this._keys.length; i++) {
      if (this._keys[i] >= hi) break;
      // Spread to avoid sharing the internal array reference with callers.
      for (const id of this._ids[i]) out.push(id);
    }
    return out;
  }

  /**
   * Full enumeration — used by snapshot serialization and tests.
   * @returns {Array<{key:string, ids:Array<string>}>}
   */
  entries() {
    const out = [];
    for (let i = 0; i < this._keys.length; i++) {
      out.push({ key: this._keys[i], ids: this._ids[i].slice() });
    }
    return out;
  }

  /**
   * Pack into a JSON-friendly POJO. Caller embeds in the snapshot.
   * @returns {{keys:Array<string>, ids:Array<Array<string>>}}
   */
  serialize() {
    return { keys: this._keys.slice(), ids: this._ids.map(a => a.slice()) };
  }

  /**
   * Reconstruct from serialize() output.
   * @param {{keys:Array<string>, ids:Array<Array<string>>}} obj
   * @returns {SortedIndex}
   */
  static deserialize(obj) {
    const idx = new SortedIndex();
    idx._keys = (obj.keys || []).slice();
    idx._ids = (obj.ids || []).map(a => a.slice());
    return idx;
  }
}

/**
 * Per-database secondary-index manager. Owns one or more SortedIndex
 * instances per collection and routes writes/lookups.
 *
 * Transaction semantics: insert/update/remove accept an optional `txnId`
 * argument. When supplied, the call is logged into a per-txn rollback
 * buffer (`_txnLog`) so `commitTxn` / `rollbackTxn` / `popStagedOp` can
 * keep the index consistent with storage-layer commit/cancel/pop. The
 * forward write itself still applies immediately — required for reads
 * inside the same txn (e.g. UC-G3 canonical-pair uniqueness pre-check)
 * to observe the staged state.
 *
 * @class SecondaryIndexManager
 */
export class SecondaryIndexManager {
  /**
   * Construct an empty manager. Each collection gets its own array of
   * declared specs once `declare()` is called for it.
   */
  constructor() {
    // collection -> [{ fields: string[], index: SortedIndex }, ...]
    this._byCollection = new Map();
    // txnId -> Array<{op, collection, doc?, oldDoc?, newDoc?}> rollback log.
    // Empty for txnIds with no logged ops; populated lazily via logTxnOp.
    this._txnLog = new Map();
  }

  /**
   * Declare a compound index on a collection.
   *
   * Idempotent on identical specs to support re-declaration after recovery
   * (the registry calls declare() again after loading from snapshot; we keep
   * the snapshot-loaded SortedIndex if the spec matches exactly).
   *
   * @param {string} collection
   * @param {Array<string>} fields - One or more field names, in priority order
   * @returns {SortedIndex} the underlying index instance for this spec
   */
  declare(collection, fields) {
    if (!this._byCollection.has(collection)) {
      this._byCollection.set(collection, []);
    }
    const specs = this._byCollection.get(collection);
    const existing = specs.find(s => s.fields.length === fields.length
                                  && s.fields.every((f, i) => f === fields[i]));
    if (existing) return existing.index;
    const entry = { fields: fields.slice(), index: new SortedIndex() };
    specs.push(entry);
    return entry.index;
  }

  /**
   * Sync all indexes for a collection on a fresh insert. When `txnId` is
   * supplied (i.e. the write happened inside an open transaction), log
   * an inverse-op so `rollbackTxn` can undo the change if the txn is
   * cancelled. The forward write applies immediately either way — reads
   * inside the same txn must observe the staged state (UC-G3 uniqueness
   * pre-check depends on this).
   *
   * @param {string} collection
   * @param {Object} doc - Document with $ID and the indexed fields
   * @param {string|null} [txnId] - Active transaction id, or null
   */
  insert(collection, doc, txnId = null) {
    if (txnId) logTxnOp(this, txnId, { op: 'insert', collection, doc: { ...doc } });
    this._applyInsert(collection, doc);
  }

  /**
   * Sync all indexes on a delete (uses the pre-delete doc body). Logs
   * an inverse-insert when called inside a txn so rollback restores the
   * removed entry.
   *
   * @param {string} collection
   * @param {Object} doc - The document being removed
   * @param {string|null} [txnId]
   */
  remove(collection, doc, txnId = null) {
    if (txnId) logTxnOp(this, txnId, { op: 'remove', collection, doc: { ...doc } });
    this._applyRemove(collection, doc);
  }

  /**
   * Sync all indexes on an update — removes the OLD key entries, inserts the
   * NEW. Logs the (oldDoc, newDoc) snapshot so rollback can swap back.
   *
   * @param {string} collection
   * @param {Object} oldDoc
   * @param {Object} newDoc
   * @param {string|null} [txnId]
   */
  update(collection, oldDoc, newDoc, txnId = null) {
    if (txnId) {
      logTxnOp(this, txnId, {
        op: 'update', collection,
        oldDoc: { ...oldDoc }, newDoc: { ...newDoc }
      });
    }
    this._applyUpdate(collection, oldDoc, newDoc);
  }

  /**
   * Apply the insert side-effect to every declared index for the
   * collection. Pure side-effect — no logging, no validation. Internal
   * use only (called by `insert` and by the rollback path).
   * @param {string} collection
   * @param {Object} doc
   * @private
   */
  _applyInsert(collection, doc) {
    const specs = this._byCollection.get(collection);
    if (!specs) return;
    for (const { fields, index } of specs) {
      const key = compoundKey(fields.map(f => doc[f] ?? null));
      index.insert(key, doc.$ID);
    }
  }

  /**
   * Apply the remove side-effect. See _applyInsert for the logging
   * contract.
   * @param {string} collection
   * @param {Object} doc
   * @private
   */
  _applyRemove(collection, doc) {
    const specs = this._byCollection.get(collection);
    if (!specs) return;
    for (const { fields, index } of specs) {
      const key = compoundKey(fields.map(f => doc[f] ?? null));
      index.remove(key, doc.$ID);
    }
  }

  /**
   * Apply the update side-effect (key churn only when oldKey !== newKey,
   * matching the public `update` semantics).
   * @param {string} collection
   * @param {Object} oldDoc
   * @param {Object} newDoc
   * @private
   */
  _applyUpdate(collection, oldDoc, newDoc) {
    const specs = this._byCollection.get(collection);
    if (!specs) return;
    for (const { fields, index } of specs) {
      const oldKey = compoundKey(fields.map(f => oldDoc[f] ?? null));
      const newKey = compoundKey(fields.map(f => newDoc[f] ?? null));
      if (oldKey !== newKey) {
        index.remove(oldKey, oldDoc.$ID);
        index.insert(newKey, newDoc.$ID);
      }
    }
  }


  /**
   * Find candidate IDs for a filter. Picks the index that covers the longest
   * prefix of the filter and returns the matching candidate set plus the
   * subset of fields it covered. Returns null if no index covers any prefix.
   *
   * Why prefix-only (not arbitrary subsets): a [a, b, c] index can answer
   * filters that constrain a, or a+b, or a+b+c — but NOT a filter that only
   * constrains b. This matches standard B-tree semantics and keeps the
   * planner predictable.
   *
   * @param {string} collection
   * @param {Object} filter - Equality-only POJO; { field: value }
   * @returns {{ids:Array<string>, covered:Array<string>}|null}
   */
  candidatesFor(collection, filter) {
    const specs = this._byCollection.get(collection);
    if (!specs || !filter || typeof filter !== 'object') return null;
    let best = null;
    for (const { fields, index } of specs) {
      // Walk the index's fields in order; stop at the first field not in
      // the filter OR not an equality-literal value. Operator clauses
      // (e.g. {$gte:5}) need range/scan handling that this v1 index
      // doesn't optimize for; treat them as residual filters instead.
      let i = 0;
      while (i < fields.length
             && Object.prototype.hasOwnProperty.call(filter, fields[i])
             && !isOperatorClause(filter[fields[i]])) {
        i++;
      }
      if (i === 0) continue; // index doesn't cover even the first field
      const prefix = fields.slice(0, i).map(f => filter[f]);
      const ids = i === fields.length
        ? index.lookup(compoundKey(prefix))
        // Range lookup for partial-prefix coverage: keys starting with the
        // serialized prefix [v0, v1, ...].  Trim the trailing ']' off the
        // canonical key and append [',' for any tail; '￿]' is the
        // exclusive upper bound.
        : index.range(
            compoundKey(prefix).slice(0, -1) + ',',
            compoundKey(prefix).slice(0, -1) + '￿]'
          );
      if (!best || i > best.coveredLen || (i === best.coveredLen && ids.length < best.ids.length)) {
        best = { ids, covered: fields.slice(0, i), coveredLen: i };
      }
    }
    if (!best) return null;
    return { ids: best.ids, covered: best.covered };
  }

  /**
   * Snapshot all collections' indexes for persistence.
   * @returns {Object} { collection -> [{fields, data}, ...] }
   */
  serialize() {
    const out = {};
    for (const [collection, specs] of this._byCollection) {
      out[collection] = specs.map(({ fields, index }) => ({
        fields: fields.slice(), data: index.serialize()
      }));
    }
    return out;
  }

  /**
   * Restore from serialize() output. Replaces existing in-memory state.
   * @param {Object} obj
   */
  load(obj) {
    this._byCollection.clear();
    for (const [collection, specs] of Object.entries(obj || {})) {
      const restored = specs.map(({ fields, data }) => ({
        fields: fields.slice(), index: SortedIndex.deserialize(data)
      }));
      this._byCollection.set(collection, restored);
    }
  }

  /**
   * Iterate declared specs (for diagnostics / drift checks).
   * @returns {Iterable<[string, Array<{fields:Array<string>}>]>}
   */
  collections() {
    const summary = new Map();
    for (const [collection, specs] of this._byCollection) {
      summary.set(collection, specs.map(s => ({ fields: s.fields.slice() })));
    }
    return summary.entries();
  }
}

export { SortedIndex, compoundKey };
export default SecondaryIndexManager;
