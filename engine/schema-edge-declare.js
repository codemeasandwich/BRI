/**
 * @file Helpers for processing the `$edge` block at schema-declaration time.
 *
 * Lives next to schema-registry.js so the registry's declare() stays
 * compact. The two responsibilities here:
 *
 *   1. Resolve the concrete from/to field names from the schema's ref-type
 *      fields (per spec §2.1.3, declaration order picks the from then to).
 *      $edge.from / $edge.to in the schema are collection-name constraints,
 *      not field names.
 *
 *   2. Validate predicate names against the frozen RESERVED_PROXY_NAMES
 *      list (§0.4). Throws on collision so reserved tokens stay reserved.
 *
 *   3. Detect cross-schema predicate ambiguity — the same predicate name
 *      cannot map to two different edge collections from the same subject.
 */

/**
 * Reserved proxy / chain names per spec §0.4. Predicate names colliding with
 * these are rejected at schema-load time. The list is FROZEN as part of v1
 * delivery; additions are breaking changes.
 */
export const RESERVED_PROXY_NAMES = new Set([
  '$', 'history', 'asOf', 'chain', 'expand', 'inverse', 'related',
  'confidence', 'withProvenance',
  'near', 'match', 'where', 'combine', 'limit', 'count', 'groupBy',
  'distinct', 'having',
  'touching', 'hydrate', 'toArray', 'first',
  'save', 'toObject', 'toJSON', 'toJSS', 'and'
]);

/**
 * Process a schema's $edge block and emit:
 *   - the enriched edge spec (with concrete field names) for storage in
 *     the registry and graph index
 *   - the list of registered predicate names (already reserved-name-checked)
 *
 * @param {string} collection - Name of the edge collection being declared
 * @param {Object} schemaDef - Full schema definition (fields + $edge + ...)
 * @returns {{enrichedSpec:Object, predicates:Array<string>|null}}
 * @throws {Error} on missing ref fields, reserved-name collision
 */
export function buildEdgeSpec(collection, schemaDef) {
  const edge = schemaDef.$edge;

  // First two ref fields in declaration order become from / to fields.
  const refFields = [];
  for (const [field, decl] of Object.entries(schemaDef)) {
    if (field.startsWith('$')) continue;
    if (decl && (decl.type === 'ref' || decl.type === 'ref|string')) {
      refFields.push({ field, to: decl.to });
    }
  }
  if (refFields.length < 2) {
    throw new Error(
      `Schema '${collection}' declares $edge but has fewer than two ` +
      `ref fields; need exactly two ref fields (from + to) in declaration order.`
    );
  }
  const fromField = refFields[0].field;
  const toField = refFields[1].field;
  const predicateField = edge.predicate || null;

  // Predicate vocabulary: array of names, '*' for open, or omitted.
  const predicates = Array.isArray(edge.predicates) ? edge.predicates
                   : edge.predicates === '*' ? null
                   : null;
  if (predicates) {
    for (const name of predicates) {
      if (RESERVED_PROXY_NAMES.has(name)) {
        throw new Error(
          `Schema '${collection}' declares predicate '${name}' which is ` +
          `reserved by the proxy surface (chain methods, save, etc.). ` +
          `Rename the predicate at the schema level.`
        );
      }
    }
  }

  const enrichedSpec = {
    from: fromField,
    to: toField,
    predicate: predicateField,
    fromCollection: edge.from,
    toCollection: edge.to,
    predicates,
    symmetric: !!edge.symmetric,
    unique: !!edge.unique
  };
  return { enrichedSpec, predicates };
}

/**
 * Register predicate names against the per-subject lookup map. Throws if a
 * predicate is already claimed by a different edge collection.
 *
 * @param {Map<string,Map<string,string>>} predicatesBySubject - Mutated in place
 * @param {Object} edge - Original $edge block (for the from collection)
 * @param {string} edgeCollection - Name of the edge collection
 * @param {Array<string>} predicates - Predicate names to register
 * @throws {Error} on cross-schema ambiguity
 */
export function registerPredicateRouting(predicatesBySubject, edge, edgeCollection, predicates) {
  if (!predicates || !edge.from) return;
  if (!predicatesBySubject.has(edge.from)) {
    predicatesBySubject.set(edge.from, new Map());
  }
  const map = predicatesBySubject.get(edge.from);
  for (const pred of predicates) {
    if (map.has(pred) && map.get(pred) !== edgeCollection) {
      throw new Error(
        `Predicate '${pred}' is registered on both ` +
        `'${map.get(pred)}' and '${edgeCollection}' as edges from ` +
        `'${edge.from}'. Each predicate must map to one edge collection.`
      );
    }
    map.set(pred, edgeCollection);
  }
}

/**
 * Mirror of registerPredicateRouting for the object-side. Used by inverse
 * predicate reads (`acme.inverse.works_at`) — given the entity's collection
 * and a predicate name, the registry can find the matching edge collection
 * even when this entity is on the TO side.
 *
 * Polymorphic to-collections (`'kgEntity | string'`) are split on `|` so
 * each component collection registers independently. The literal `string`
 * pseudo-collection is skipped — entities can't be plain literals.
 *
 * @param {Map<string,Map<string,string>>} predicatesByObject - Mutated in place
 * @param {Object} edge - Original $edge block (uses edge.to for routing)
 * @param {string} edgeCollection - Name of the edge collection
 * @param {Array<string>} predicates - Predicate names to register
 * @throws {Error} on cross-schema ambiguity
 */
export function registerInversePredicateRouting(predicatesByObject, edge, edgeCollection, predicates) {
  if (!predicates || !edge.to) return;
  // Split polymorphic to-constraints; skip literal pseudo-collection.
  const toCollections = String(edge.to)
    .split('|').map(s => s.trim()).filter(c => c && c !== 'string');
  for (const objCollection of toCollections) {
    if (!predicatesByObject.has(objCollection)) {
      predicatesByObject.set(objCollection, new Map());
    }
    const map = predicatesByObject.get(objCollection);
    for (const pred of predicates) {
      if (map.has(pred) && map.get(pred) !== edgeCollection) {
        throw new Error(
          `Predicate '${pred}' inverse-registered on both ` +
          `'${map.get(pred)}' and '${edgeCollection}' as edges to ` +
          `'${objCollection}'. Each (collection, predicate) pair must map to ` +
          `one edge collection.`
        );
      }
      map.set(pred, edgeCollection);
    }
  }
}
