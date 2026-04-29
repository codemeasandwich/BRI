/**
 * @file Shared V8-shaped schemas for vector + graph tests.
 *
 * Per spec §5.2: a single source of truth for the collection schemas
 * used across UC-V*, UC-G*, UC-X* tests. Re-declaring schemas inline in
 * each suite caused subtle drift; importing from this fixture lets the
 * spec-mandated tests (bulk, recovery, scenarios) compose without
 * worrying about whether the schema matches the V8 field names.
 *
 * Field names match the V8 design language: snake_case ids, _id suffix
 * for refs, supersession field named `superseded_by_id`, etc. Embedding
 * dimension defaults to 8 for fast tests; production V8 uses 1536.
 *
 * Apply via `applyFixtureSchemas(db, { dims })` so a single call wires
 * every collection at once. Tests that only need one or two collections
 * can import the individual schema constants and call `db.schema(name, schema)`
 * directly.
 */

const DEFAULT_DIMS = 8;

/**
 * Memory artifact (UC-V1, UC-V2, UC-V3, UC-X2, UC-X3, UC-X4).
 * The vector field is `embedding`; supersession via `superseded_by_id`.
 *
 * @param {number} [dims=8] - Embedding dimensionality
 * @returns {Object}
 */
export function memoryArtifactSchema(dims = DEFAULT_DIMS) {
  return {
    type:                  { type: String, required: true,
                             enum: ['fact', 'preference', 'goal', 'event'] },
    content:               { type: String, required: false },
    embedding:             { type: 'vector', dims },
    aliases:               { type: Array, items: String, required: false },
    confidence:            { type: Number, required: false },
    usage_count:           { type: Number, required: false },
    superseded_by_id:      { type: 'ref', to: 'memoryArtifact', required: false },
    promoted_at:           { type: Date,  required: false },
    source_session_id:     { type: String, required: false, cascadeOn: 'session' },
    provenance_turn_ids:   { type: Array, items: String, required: false },

    $indexes:      [['type', 'superseded_by_id'], ['source_session_id']],
    $supersession: 'superseded_by_id',
    $confidence:   'confidence',
    $provenance:   'provenance_turn_ids'
  };
}

/**
 * Knowledge graph entity (UC-G1, UC-G2, UC-G4, UC-G5, UC-G6, UC-G7).
 * Nodes participate in kgTriple edges; no vector field required for
 * the entity itself in v1 (entity-level embeddings are deferred).
 *
 * @returns {Object}
 */
export function kgEntitySchema() {
  return {
    name:        { type: String, required: true },
    canonical:   { type: String, required: false },
    kind:        { type: String, required: false }
  };
}

/**
 * Knowledge graph triple (edge collection). Tracks supersession for
 * UC-G4 chain walks and confidence/provenance for UC-G1 chain method
 * filters.
 *
 * @returns {Object}
 */
export function kgTripleSchema() {
  return {
    subject_id:           { type: 'ref', to: 'kgEntity', required: true },
    predicate:            { type: String, required: true },
    object_id_or_literal: { type: 'ref|string', to: 'kgEntity', required: true },
    confidence:           { type: Number, required: false },
    superseded_by_id:     { type: 'ref', to: 'kgTriple', required: false },
    supersedes_id:        { type: 'ref', to: 'kgTriple', required: false },
    provenance_turn_ids:  { type: Array, items: String, required: false },
    source_session_id:    { type: String, required: false },

    $indexes:      [['subject_id', 'predicate'], ['object_id_or_literal']],
    $supersession: 'superseded_by_id',
    $confidence:   'confidence',
    $provenance:   'provenance_turn_ids',
    $edge: {
      from:       'kgEntity',
      to:         'kgEntity',
      predicate:  'predicate',
      predicates: ['works_at', 'lives_in', 'knows', 'authored', 'founded_by']
    }
  };
}

/**
 * Lexical entity (UC-G5 — co-occurrence graph).
 * @returns {Object}
 */
export function lexicalEntitySchema() {
  return {
    name:                { type: String, required: true },
    co_occurrence_count: { type: Number, required: false }
  };
}

/**
 * Lexical edge (UC-G3 — symmetric co-occurrence edges).
 * @returns {Object}
 */
export function lexicalEdgeSchema() {
  return {
    node_a:               { type: 'ref', to: 'lexicalEntity', required: true },
    node_b:               { type: 'ref', to: 'lexicalEntity', required: true },
    co_occurrence_count:  { type: Number, required: false },
    sessions:             { type: Array, items: String, required: false },
    $indexes: [['node_a'], ['node_b']],
    $edge: { from: 'lexicalEntity', to: 'lexicalEntity', symmetric: true, unique: true }
  };
}

/**
 * Chat turn (UC-X4 — substring FTS).
 * @returns {Object}
 */
export function chatTurnSchema() {
  return {
    session_id:        { type: String, required: true, cascadeOn: 'session' },
    role:              { type: String, required: true, enum: ['user', 'assistant', 'system'] },
    content:           { type: String, required: false },
    created_at:        { type: Date,   required: false },
    $indexes: [['session_id', 'created_at']]
  };
}

/**
 * Apply every fixture schema to a fresh db instance. Returns the db
 * for chaining.
 *
 * @param {Object} db
 * @param {Object} [opts]
 * @param {number} [opts.dims=8]
 * @returns {Object} db
 */
export function applyFixtureSchemas(db, { dims = DEFAULT_DIMS } = {}) {
  db.schema('memoryArtifact',  memoryArtifactSchema(dims));
  db.schema('kgEntity',        kgEntitySchema());
  db.schema('kgTriple',        kgTripleSchema());
  db.schema('lexicalEntity',   lexicalEntitySchema());
  db.schema('lexicalEdge',     lexicalEdgeSchema());
  db.schema('chatTurn',        chatTurnSchema());
  return db;
}
