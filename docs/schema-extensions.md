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

### Collection storage identity invariant

Bri derives a compact durable storage identity from each logical
collection name with `type2Short(collection)`: the first two and last two
characters uppercased. That identity is the `$ID` prefix, the collection
membership-set namespace, and the plural group-read namespace. Because
those storage structures are durable, two logical collections must never
share the same identity.

Examples:

| Collection | Storage identity / prefix |
|---|---|
| `alpha` | `ALHA` |
| `bravo` | `BRVO` |
| `alpineHa` | `ALHA` |

Declaring or writing both `alpha` and `alpineHa` fails with
`BriSchemaError` code `COLLECTION_IDENTITY_COLLISION` before ambiguous
rows can be persisted. The error details include
`{ collections, storageIdentity, prefix }`.

Failed declarations and failed public writes do not reserve identities.
Schema registration stages vector, graph, secondary-index, cascade,
lifecycle, predicate-routing, and prefix state first, then commits the
identity and runtime maps only after all declaration checks pass. Public
write paths persist a first identity only after operation preconditions
pass and before the user row is durable. Reads and failed deletes never
create identities.

Use the public diagnostic surface to inspect known mappings or preflight
candidate names:

```js
db.diag.collectionIdentities();
db.diag.collectionIdentities(['alpha', 'alpineHa']);
```

Rows have `{ collection, storageIdentity, prefix, unique, conflicts }`.
The optional candidate list is a projection only; it does not register a
schema or reserve the identity.

Bri does not currently support explicit user-supplied collection storage
identities. The supported contract is derived identities plus fail-fast
collision rejection. Keeping the identity derived from the collection
name preserves the existing `$ID`, set, WAL, and snapshot layout for
non-colliding stores while preventing silent namespace overlap.

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
| `symmetric` | Boolean. Marks the edge as undirected — `(A, B)` and `(B, A)` describe the same logical edge. Required when paired with `unique: true`. Also governs traversal direction in `expand({direction: 'both'})`. |
| `unique` | Boolean. When true, the edge collection enforces **at most one edge per unordered pair** of endpoints (UC-G3). **Requires** `symmetric: true` — declaring `unique: true` without `symmetric: true` throws `EDGE_UNIQUE_REQUIRES_SYMMETRIC` at schema-load time, since ordered uniqueness has different semantics. Backed by the canonical-pair secondary index; duplicate inserts throw `EDGE_PAIR_NOT_UNIQUE`. Enables the `.between(a, b)` chain method on the QueryBuilder. See [docs/graph.md → Unique symmetric edges](graph.md#unique-symmetric-edges-uc-g3). |

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
