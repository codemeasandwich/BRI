/**
 * @file Sample knowledge-graph fixtures for §F Test 2 (KG triples).
 *
 * Returns a small but realistic graph: 8 entities + 12 triples covering
 * the predicates used across the spec's UC-G1..G7 examples. Each triple
 * has confidence + provenance fields populated so tests asserting on
 * those chain methods have meaningful data.
 *
 * Function form (not a static export) so each test gets a fresh copy of
 * the records; `db.add` mutates the documents to attach $IDs.
 */

/**
 * Build entity records.
 *
 * @returns {Array<{name:string, kind:string}>}
 */
export function entityRecords() {
  return [
    { name: 'Alice',    kind: 'person'  },
    { name: 'Bob',      kind: 'person'  },
    { name: 'Carol',    kind: 'person'  },
    { name: 'Dave',     kind: 'person'  },
    { name: 'Acme',     kind: 'company' },
    { name: 'Initech',  kind: 'company' },
    { name: 'Brooklyn', kind: 'place'   },
    { name: 'Berlin',   kind: 'place'   }
  ];
}

/**
 * Build triple records given a name→$ID lookup. Each triple uses
 * `subject_id` / `predicate` / `object_id_or_literal` matching the
 * KGTripleSchema in tests/fixtures/schemas.js.
 *
 * @param {Object<string,string>} ids - name → $ID
 * @returns {Array<Object>}
 */
export function tripleRecords(ids) {
  /**
   * One triple row aligned with KGTripleSchema in schemas.js.
   * @param {string} subject - Entity name whose $ID resolves from ids
   * @param {string} predicate
   * @param {string} object - Entity name or literal string when unmapped
   * @param {Object} [attrs]
   * @returns {Object}
   */
  const t = (subject, predicate, object, attrs = {}) => ({
    subject_id: ids[subject],
    predicate,
    object_id_or_literal: ids[object] || object,
    confidence: 0.85,
    source_session_id: 'fixture',
    provenance_turn_ids: ['fixture-turn-1'],
    ...attrs
  });
  return [
    t('Alice', 'works_at', 'Acme',     { confidence: 0.95 }),
    t('Bob',   'works_at', 'Acme',     { confidence: 0.9 }),
    t('Carol', 'works_at', 'Initech',  { confidence: 0.92 }),
    t('Dave',  'works_at', 'Initech',  { confidence: 0.7 }),
    t('Alice', 'lives_in', 'Brooklyn'),
    t('Bob',   'lives_in', 'Brooklyn'),
    t('Carol', 'lives_in', 'Berlin'),
    t('Dave',  'lives_in', 'Berlin'),
    t('Alice', 'knows',    'Bob',      { confidence: 0.8 }),
    t('Alice', 'knows',    'Carol',    { confidence: 0.6 }),
    t('Bob',   'knows',    'Dave',     { confidence: 0.7 }),
    t('Carol', 'knows',    'Dave',     { confidence: 0.85 })
  ];
}

/**
 * Convenience: load entities then triples. Returns { entities, triples,
 * idsByName } so the caller can assert on relationships without manually
 * threading IDs.
 *
 * @param {Object} db - Bri db instance with kgEntity + kgTriple schemas applied
 * @returns {Promise<{entities:Array, triples:Array, idsByName:Object}>}
 */
export async function loadKGFixture(db) {
  const entities = [];
  const idsByName = {};
  for (const rec of entityRecords()) {
    const ent = await db.add.kgEntity(rec);
    entities.push(ent);
    idsByName[rec.name] = ent.$ID;
  }
  const triples = [];
  for (const rec of tripleRecords(idsByName)) {
    const t = await db.add.kgTriple(rec);
    triples.push(t);
  }
  return { entities, triples, idsByName };
}
