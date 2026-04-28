/**
 * @file Graph adjacency index for edge collections.
 *
 * Per spec §3.1, the graph layer maintains forward and inverse adjacency
 * maps so predicate reads (`alice.works_at`) and inverse reads
 * (`acme.inverse.works_at`) resolve in O(degree) rather than scanning the
 * edge collection.
 *
 * Architecture:
 *   - One GraphIndex instance per database, owned by the schema registry
 *     (parallel to SecondaryIndexManager).
 *   - declareEdge(collection, edgeSpec) registers the collection's edge
 *     shape (from/to fields, predicate field, optional predicates list).
 *   - insertEdge / removeEdge keep adjacency in sync; called by the
 *     middleware that already pre-fetches old-doc state on set/del.
 *   - outgoing / incoming / related are the lookup primitives consumed by
 *     the predicate proxy.
 *
 * Storage shape:
 *   _edgeSpec: collection -> { from, to, predicate, predicates }
 *   _outgoing: collection -> Map<nodeId, Map<predicate, Set<edgeId>>>
 *   _incoming: collection -> Map<nodeId, Map<predicate, Set<edgeId>>>
 *
 * Why nested Maps + Sets:
 *   - Map<predicate, Set<edgeId>> means a single predicate filter is O(1)
 *     to retrieve the matching edge ids for a node.
 *   - Sets dedupe edges; an idempotent re-insert costs nothing.
 *   - Nesting by collection lets one node id appear in multiple edge
 *     collections without colliding.
 *
 * Persistence:
 *   serialize() emits a JSON-friendly POJO. v1 keeps the format readable
 *   (id strings, not packed binary) — adjacency entries are small. The
 *   storage layer embeds it inside snapshot v3 alongside vector and
 *   secondary indexes.
 */

/**
 * Per-database graph index. Holds adjacency for every declared edge
 * collection.
 *
 * @class GraphIndex
 */
export class GraphIndex {
  /**
   * Construct an empty graph index. declareEdge() must be called for each
   * edge collection before insertEdge can run for it.
   */
  constructor() {
    this._edgeSpec = new Map();
    this._outgoing = new Map();
    this._incoming = new Map();
  }

  /**
   * Register an edge collection's shape. Idempotent on identical specs so
   * recovery + re-declare don't double-register.
   *
   * @param {string} collection - Edge collection name (e.g. 'kgTriple')
   * @param {Object} edgeSpec - From the schema's $edge block
   * @param {string} edgeSpec.from - Field on the edge holding subject $ID
   * @param {string} edgeSpec.to - Field holding object $ID
   * @param {string} [edgeSpec.predicate] - Field holding predicate name
   *   (omitted edges are treated as relation-typed; a synthetic '*' key
   *   is used internally so existing lookups still work)
   */
  declareEdge(collection, edgeSpec) {
    this._edgeSpec.set(collection, edgeSpec);
    if (!this._outgoing.has(collection)) this._outgoing.set(collection, new Map());
    if (!this._incoming.has(collection)) this._incoming.set(collection, new Map());
  }

  /**
   * Look up an edge spec by collection.
   *
   * @param {string} collection
   * @returns {Object|undefined}
   */
  edgeSpecFor(collection) {
    return this._edgeSpec.get(collection);
  }

  /**
   * Insert an edge into the adjacency. Reads the from/to/predicate fields
   * off the doc using the spec. Idempotent — Set semantics dedupe.
   *
   * @param {string} collection - Edge collection name
   * @param {Object} doc - Edge document (must have $ID and the edge fields)
   */
  insertEdge(collection, doc) {
    const spec = this._edgeSpec.get(collection);
    if (!spec || !doc || !doc.$ID) return;
    const subjectId = doc[spec.from];
    const objectId = doc[spec.to];
    const predicate = spec.predicate ? (doc[spec.predicate] || '*') : '*';
    if (!subjectId || !objectId) return;
    this._addAdjacency(this._outgoing, collection, subjectId, predicate, doc.$ID);
    this._addAdjacency(this._incoming, collection, objectId, predicate, doc.$ID);
  }

  /**
   * Remove an edge from the adjacency. Caller must supply the pre-delete
   * doc body so we know which keys to remove from.
   *
   * @param {string} collection
   * @param {Object} doc
   */
  removeEdge(collection, doc) {
    const spec = this._edgeSpec.get(collection);
    if (!spec || !doc || !doc.$ID) return;
    const subjectId = doc[spec.from];
    const objectId = doc[spec.to];
    const predicate = spec.predicate ? (doc[spec.predicate] || '*') : '*';
    if (!subjectId || !objectId) return;
    this._removeAdjacency(this._outgoing, collection, subjectId, predicate, doc.$ID);
    this._removeAdjacency(this._incoming, collection, objectId, predicate, doc.$ID);
  }

  /**
   * Outgoing edge $IDs from a node, optionally filtered by predicate name.
   *
   * @param {string} nodeId - Subject $ID
   * @param {string} collection - Edge collection
   * @param {string} [predicate] - Optional predicate filter; omit for all
   * @returns {Array<string>} Edge $IDs
   */
  outgoing(nodeId, collection, predicate) {
    return this._lookup(this._outgoing, nodeId, collection, predicate);
  }

  /**
   * Incoming edge $IDs to a node, optionally filtered by predicate name.
   *
   * @param {string} nodeId - Object $ID
   * @param {string} collection - Edge collection
   * @param {string} [predicate] - Optional predicate filter; omit for all
   * @returns {Array<string>} Edge $IDs
   */
  incoming(nodeId, collection, predicate) {
    return this._lookup(this._incoming, nodeId, collection, predicate);
  }

  /**
   * Pack into a JSON-friendly POJO. Caller embeds in the snapshot.
   * @returns {Object}
   */
  serialize() {
    const out = { specs: {}, outgoing: {}, incoming: {} };
    for (const [collection, spec] of this._edgeSpec) {
      out.specs[collection] = spec;
    }
    out.outgoing = this._serializeAdjacency(this._outgoing);
    out.incoming = this._serializeAdjacency(this._incoming);
    return out;
  }

  /**
   * Restore from a serialize() output. Replaces existing in-memory state.
   * @param {Object} obj
   */
  load(obj) {
    this._edgeSpec.clear();
    this._outgoing.clear();
    this._incoming.clear();
    if (!obj) return;
    for (const [collection, spec] of Object.entries(obj.specs || {})) {
      this._edgeSpec.set(collection, spec);
    }
    this._outgoing = this._deserializeAdjacency(obj.outgoing || {});
    this._incoming = this._deserializeAdjacency(obj.incoming || {});
  }

  /**
   * Add (collection, nodeId, predicate, edgeId) to a directional adjacency.
   * @param {Map} map - _outgoing or _incoming
   * @param {string} collection
   * @param {string} nodeId
   * @param {string} predicate
   * @param {string} edgeId
   * @private
   */
  _addAdjacency(map, collection, nodeId, predicate, edgeId) {
    if (!map.has(collection)) map.set(collection, new Map());
    const collMap = map.get(collection);
    if (!collMap.has(nodeId)) collMap.set(nodeId, new Map());
    const predMap = collMap.get(nodeId);
    if (!predMap.has(predicate)) predMap.set(predicate, new Set());
    predMap.get(predicate).add(edgeId);
  }

  /**
   * Remove (collection, nodeId, predicate, edgeId) from a directional
   * adjacency. Empty entries are pruned so the map never carries stale
   * predicate keys.
   * @param {Map} map - _outgoing or _incoming
   * @param {string} collection
   * @param {string} nodeId
   * @param {string} predicate
   * @param {string} edgeId
   * @private
   */
  _removeAdjacency(map, collection, nodeId, predicate, edgeId) {
    const collMap = map.get(collection);
    if (!collMap) return;
    const predMap = collMap.get(nodeId);
    if (!predMap) return;
    const set = predMap.get(predicate);
    if (!set) return;
    set.delete(edgeId);
    if (set.size === 0) predMap.delete(predicate);
    if (predMap.size === 0) collMap.delete(nodeId);
  }

  /**
   * Look up edge ids in either direction. Returns a fresh array so callers
   * can safely mutate.
   * @param {Map} map - _outgoing or _incoming
   * @param {string} nodeId
   * @param {string} collection
   * @param {string|undefined} predicate - Optional predicate filter
   * @returns {Array<string>} edge $IDs
   * @private
   */
  _lookup(map, nodeId, collection, predicate) {
    const collMap = map.get(collection);
    if (!collMap) return [];
    const predMap = collMap.get(nodeId);
    if (!predMap) return [];
    if (predicate) {
      const set = predMap.get(predicate);
      return set ? [...set] : [];
    }
    const out = [];
    for (const set of predMap.values()) {
      for (const id of set) out.push(id);
    }
    return out;
  }

  /**
   * Convert a directional adjacency Map<...> into a JSON-friendly POJO.
   * @param {Map} map - _outgoing or _incoming
   * @returns {Object} JSON-shaped adjacency data
   * @private
   */
  _serializeAdjacency(map) {
    const out = {};
    for (const [collection, collMap] of map) {
      out[collection] = {};
      for (const [nodeId, predMap] of collMap) {
        out[collection][nodeId] = {};
        for (const [predicate, set] of predMap) {
          out[collection][nodeId][predicate] = [...set];
        }
      }
    }
    return out;
  }

  /**
   * Inverse of _serializeAdjacency.
   * @param {Object} obj - JSON-shaped adjacency data
   * @returns {Map} reconstituted Map<...> structure
   * @private
   */
  _deserializeAdjacency(obj) {
    const map = new Map();
    for (const [collection, collObj] of Object.entries(obj)) {
      const collMap = new Map();
      for (const [nodeId, predObj] of Object.entries(collObj)) {
        const predMap = new Map();
        for (const [predicate, ids] of Object.entries(predObj)) {
          predMap.set(predicate, new Set(ids));
        }
        collMap.set(nodeId, predMap);
      }
      map.set(collection, collMap);
    }
    return map;
  }
}

export default GraphIndex;
