# Schema Extensions — vector + graph vocabulary

The schema validator (`utils/schema/index.js`) and the schema registry
(`engine/schema-registry.js`) understand a vocabulary of field types and
collection-level options that v1 introduces alongside the existing
`String`, `Number`, `Boolean`, `Date`, `Object`, `Array`, `'email'`, and
`'ref'` types. This page is the reference.

## New field types

### `'vector'` — embedded float array

```js
embedding: { type: 'vector', dims: 1536, metric: 'cosine' }
```

| Option | Required | Default | Notes |
|---|---|---|---|
| `dims` | yes | — | Positive integer; every value must match exactly. |
| `metric` | no | `'cosine'` | v1 only supports `'cosine'`. |

Validation:
- non-array → throws `BriValidationError` `FIELD_TYPE_MISMATCH`
- length ≠ dims → throws `VECTOR_DIMS_MISMATCH`
- NaN / Infinity / non-numeric element → throws `VECTOR_INVALID_VALUE`

Stored as a `Float32Array` row in the per-collection `VectorIndex`. See
[vector.md](vector.md) for usage with `.near` / `.match` / `.combine`.

### `'ref'` — typed document reference

```js
author_id: { type: 'ref', to: 'user' }
```

The value must match the Bri ID pattern `^[A-Z]{4}_[0-9a-hjkmnp-rtu-z]{7}$`
(see `engine/id.js` → `makeid`). Existence of the target doc is checked
by the engine middleware at write time; the validator only enforces the
shape so a typo is caught early. Throws:
- `FIELD_TYPE_MISMATCH` on non-string
- `REF_FORMAT_INVALID` on malformed ID
- `REF_NOT_FOUND` (engine boundary) when the target doc doesn't exist

### `'ref|string'` — polymorphic reference or literal

```js
object_id_or_literal: { type: 'ref|string', to: 'kgEntity' }
```

Used for triple objects that may be either an entity reference or a
literal string. If the value starts with the four-uppercase-letters +
underscore pattern it is treated as a candidate ref and must match the
full ID pattern; otherwise any non-empty string is allowed.

### `'predicate'` — string drawn from a registered vocabulary

```js
predicate: { type: 'predicate', collection: 'kgTriple' }
```

Validates that the value is a non-empty string. The exact predicate
vocabulary lives on the edge collection's `$edge.predicates` declaration
and is enforced by the schema registry (not the validator). Most edge
collections name their predicate field via `$edge.predicate` instead of
declaring an explicit `'predicate'` field.

## Collection-level options

```js
const KGTripleSchema = {
  // ...field definitions...

  $indexes: [
    ['subject_id', 'predicate'],          // compound; UC-G2
    ['object_id_or_literal'],             // single-field; UC-G1 reverse
    ['source_session_id', 'superseded_by_id']  // UC-X2 + filter
  ],

  $supersession: 'superseded_by_id',
  $confidence:   'confidence',
  $provenance:   'provenance_turn_ids',

  $edge: {
    from:        'kgEntity',
    to:          'kgEntity | string',
    predicate:   'predicate',
    predicates:  ['works_at', 'lives_in'],
    symmetric:   false,
    unique:      false
  }
};
```

| Option | Effect |
|---|---|
| `$indexes` | Engine maintains the named secondary indexes. The query planner uses them; queries that match a prefix get O(log n) lookup instead of full scan. Index state is persisted in snapshots and updated synchronously on every write. |
| `$supersession` | Names the field used for supersession backref. Default reads filter `WHERE field IS NULL`; `.history` / `.asOf(t)` opt out. |
| `$confidence` | Names the field carrying numeric confidence. Enables `.confidence(threshold)` chain method. |
| `$provenance` | Names the field carrying provenance ids. Enables `.withProvenance` chain method that hydrates `$provenance` metadata onto results. |
| `$edge` | Marks the collection as an edge collection. See below. |

### `$edge` block

| Key | Meaning |
|---|---|
| `from` | Collection name expected on the from-side reference field. Used to validate edge construction. |
| `to` | Collection name (or `'A | B'` for polymorphic, where `string` means "literal"). |
| `predicate` | Name of the field on the edge document that holds the predicate string. Optional — if absent the edge is treated as relation-typed. |
| `predicates` | Array of allowed predicate values, or `'*'` for open. v1 routes only explicit lists (`'*'` disables predicate-proxy routing for that edge). |
| `symmetric` | Boolean. When true, `.coOccursWith(b, attrs)` and `b.coOccursWith(a, attrs)` produce a canonical edge by sorting the endpoint pair lexicographically. |
| `unique` | Boolean. When true, `(from, to, predicate)` is a uniqueness key — repeat writes upsert. |

### Field-level `cascadeOn`

```js
source_session_id: { type: String, cascadeOn: 'session' }
```

Opts the document into `db.cascade.session(id)` semantics. Knowledge
collections leave the flag off — they are immune to memory-tier cascades
(spec §0.3 #4 two-store invariant). Future scopes (`'tenant'`,
`'project'`) work identically — declare the flag and call
`db.cascade.tenant(id)`.

## Reserved names (spec §0.4)

The following names are reserved by the proxy surface; predicates AND
ref-field names colliding with them throw `BriSchemaError`
`RESERVED_NAME_COLLISION` at schema load:

```
$  history  asOf  chain  expand  inverse  related
confidence  withProvenance
near  match  where  combine  limit  count  groupBy  distinct  having
touching  hydrate  toArray  first
save  toObject  toJSON  toJSS  and
```

The list is FROZEN as part of v1 delivery; additions are breaking changes.

## Schema load-time validation (spec §2.1.4)

The schema loader throws (not at query time, at startup) on:

| Violation | Code |
|---|---|
| Predicate name collides with reserved word | `RESERVED_NAME_COLLISION` |
| Ref field name collides with reserved word | `RESERVED_NAME_COLLISION` |
| `$supersession` / `$confidence` / `$provenance` names an undeclared field | `INDEX_FIELD_NOT_DECLARED` |
| `$edge` declared with fewer than two ref fields | `EDGE_REF_FIELDS_MISSING` |
| Same predicate registered on two edge collections from one subject | `PREDICATE_AMBIGUOUS` |

Catch these at startup so deployments fail fast instead of producing
silently broken queries downstream.
