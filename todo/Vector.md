# Bri Vector + Graph — Implementation Task

> **Status:** Ready to execute. Self-contained.
> **Audience:** Fresh Claude instance or human implementer with no prior conversation context.
> **Predecessor:** None at the code level. Builds on existing Bri (in-house store, WAL, snapshots, reactive entities, `.and` proxy, transactions, schema validator, middleware).
> **Successor:** Ashlyn V8 memory + knowledge plugins consume this surface.

---

## 0. What you need to know before touching code

### 0.1 What Bri is

Bri is a single-process JavaScript document database with:

- **Hot/cold storage tiers.** LRU-evicted in-memory hot tier; JSON-file cold tier under `data/docs/`.
- **WAL + snapshots.** Every write is journaled to `data/wal/` then reflected in a snapshot under `data/snapshots/` periodically. Crash recovery replays WAL on top of last snapshot.
- **Reactive entities.** `db.get.user(id)` returns a Proxy-wrapped object that tracks mutations and persists on `entity.save()`.
- **Dynamic collection proxy.** `db.add.foo(...)`, `db.get.foo(...)`, `db.del.foo(...)`, `db.set.foo(...)`, `db.sub.foo(cb)` — collection name is intercepted by the proxy at access time. Trailing `S` means batch (`db.get.userS(...)` returns array).
- **Reference population.** `entity.and.author` resolves a single ref. `entity.and.author.and.friends` chains.
- **Transactions.** `db.rec()` opens a transaction, `db.fin()` commits, `db.nop()` cancels, `db.pop()` undoes the last action. Active txn auto-binds to `db._activeTxnId`.
- **Schema validator.** `utils/schema.js` validates document shape against a declared schema. Currently supports `String`, `Number`, `Boolean`, `Date`, `Object`, `Array`, `'email'`, `'ref'`. Per-field options: `required`, `enum`, `properties`, `items`, `get`/`set` transforms.
- **Middleware.** `db.use(fn)` wraps CRUD ops with `(ctx, next) => {}` async middleware. Built-ins: transaction, logging, validation, hooks.
- **JSS serialization.** Extended JSON preserving `Date`, `RegExp`, `Map`, `Set`, `Error`, `undefined`, circular refs.
- **In-process only.** No client/server split. All ops run in the same Node.js process. Worker Threads are available and used where CPU-bound.

### 0.2 What already exists in the codebase you'll extend

```
/client/         Public surface — proxy traps for db.get/add/set/del/sub, .and population
/engine/         In-memory data + change tracking, ID generation, CRUD coordination, middleware
/storage/inhouse/  Hot tier (LRU), cold tier (JSON), WAL, snapshots, pub/sub
/utils/schema.js   Schema validator
/utils/jss.js      Extended JSON serialization
/utils/diff.js     Change tracking
/index.d.ts        TypeScript surface
/tests/e2e/        Jest suites: crud, transactions, middleware, reactive, pubsub, schema, jss, sets, memory, persistence, encryption
```

### 0.3 The non-negotiables (do not violate)

1. **Zero-config philosophy.** A user who declares a schema with vector or ref fields should not have to configure index types, dimensions tuning, HNSW parameters, etc. by default. Sensible defaults derived from schema. Tuning is opt-in via schema flags.
2. **No external runtime dependencies in core for v1.** Pure JS HNSW for v1. Native acceleration is a v2/v3 lever, gated behind a feature flag, with the pure-JS fallback always available.
3. **Stage-then-commit discipline.** Vector index updates and graph index updates inside an open transaction MUST NOT be visible to searches outside the transaction. `nop()` MUST leave the indexes bit-identical to the pre-`rec()` state. `pop()` MUST roll back the most recent index delta along with its document write. Crash mid-transaction MUST recover to the pre-transaction state.
4. **Two-store invariant.** Memory tier (`MemoryArtifact`) and Knowledge tier (`KGEntity`, `KGTriple`) are independent collections. Cascade deletes on cancellation MUST NOT touch knowledge collections. The schema flag `cascadeOn` is the only mechanism that opts a collection into cascade scope.
5. **Cancellation cascade correctness.** A cancelled session's cascade MUST leave no orphaned vectors, no orphaned graph nodes/edges, no provisional index entries, across all collections marked `cascadeOn: 'session'`.
6. **Encryption parity.** Embedding values inherit the existing AES-256-GCM at-rest encryption under `BRI_ENCRYPTION_KEY`. The vector index is either encrypted at rest (if persisted) OR is recomputed from encrypted documents on boot (if held in memory only). A plaintext index file alongside encrypted documents is a non-starter.
7. **Reactive entity model preserved.** Search results are still reactive entities; `result.save()` works. The `$score`, `$cosine`, `$aliasHit`, `$provenance` fields are non-persisted metadata attached to the entity proxy and excluded from `toObject()`/`toJSON()` output unless `entity.toObject({includeMeta: true})`.

### 0.4 Reserved proxy method names (cannot collide with predicates / fields)

The proxy exposes these names as engine-controlled. Schema load MUST throw if a predicate, ref field, or virtual field name collides with any of:

```
$  history  asOf  chain  expand  inverse  related  confidence  withProvenance
near  match  where  combine  limit  count  groupBy  distinct  having  
touching  hydrate  toArray  first  save  toObject  toJSON  toJSS  and
```

(`and` is preserved for backwards compatibility with existing `.and.{field}` ref population.)

---

## 1. Architectural decisions (made; do not revisit)

These were settled in the design phase. The implementer owns details, not the direction.

| Decision | Rationale |
|---|---|
| **Schema is the single source of truth.** Vector fields, ref fields, edge collection markers, predicate vocabularies, supersession field, confidence field, provenance field, indexes, cascade scope are all schema-declared. | The proxy infers every capability from schema; nothing is configured at the call site. Same declarations drive validation, indexing, proxy method availability, and cascade. |
| **Pure-JS HNSW for v1; pluggable native acceleration for v2/v3.** | Keeps the install zero-dep at v1 scale (1k–10k vectors). The index module exposes a stable interface (`add`, `remove`, `search`, `searchFiltered`, `serialize`, `deserialize`); a USearch-backed implementation slots in behind the same interface in v2 without API changes. |
| **Worker Thread for index operations.** A single index worker holds HNSW + adjacency. Main thread sends search/walk requests via `MessageChannel`. | Bulk inserts (UC-V5) cannot block request-path queries. Search is CPU-bound. Worker boundary is also a clean serialization edge — only `{id, score}` pairs cross; main thread hydrates to entities. |
| **Tombstone-based transaction integration.** Inserts inside a transaction add to the index marked `pending(txnId)`. Searches outside the txn skip pending entries. `fin()` clears the marker; `nop()` removes the entry. | Avoids journaling full HNSW topology deltas. Correct for UC-V4 acceptance criteria. The trade-off (slightly larger working-set for long transactions) is acceptable at target scales. |
| **Predicate access via proxy is the primary write/read API for edges.** `alice.works_at(bob, attrs)` writes; `alice.works_at` reads targets; `alice.works_at.$` reads edge documents. | Eliminates boilerplate for edge construction, naming, supersession filtering, confidence filtering. Reads as English. |
| **Schema-declared cascade scope.** `cascadeOn: 'session'` on a field of type `String`. `db.cascade.session(id)` walks all collections with that flag. | The opt-in lives at the data definition. Knowledge collections (no flag) are immune. New cascade scopes (`'tenant'`, `'project'`) added by schema authors without engine changes. |
| **Phased delivery aligned to v1 / v2 / v3.** Capability surface is built in v1; performance + scale come in v2/v3. | Spec'd UC scales: v1 ≤ 10k, v2 ≤ 100k, v3 ≤ 1M. v1 acceptance is correctness; v2 acceptance is latency budgets; v3 is scale-out. |

---

## 2. The capability surface (the API contract)

This section is the contract Ashlyn will program against. Every signature, behavior, and error mode is binding.

### 2.1 Schema extensions

The schema validator (`utils/schema.js`) gains new field types and collection-level options.

#### 2.1.1 New field types

```js
// Vector field — embedded array of floats
embedding: { type: 'vector', dims: 1536, metric: 'cosine' }
//                            └──┬──┘   └────┬─────┘
//                          required   default 'cosine'; v1 supports 'cosine' only

// Reference to another collection's document by $ID
subject_id: { type: 'ref', to: 'kgEntity' }

// Polymorphic ref-or-literal — used for triple objects
object_id_or_literal: { type: 'ref|string', to: 'kgEntity' }

// Predicate field — string drawn from a registered predicate vocabulary
predicate: { type: 'predicate', collection: 'kgTriple' }
// (rare; usually inferred — see 2.1.3)
```

Validation rules:
- `'vector'` validates: array of finite numbers, length matches `dims`, no NaN/Infinity. Throws `BriValidationError` with code `'VECTOR_DIMS_MISMATCH'` or `'VECTOR_INVALID_VALUE'`.
- `'ref'` validates: the value is a string matching the ID pattern (`^[A-Z]{4}_[0-9A-HJ-NP-TV-Z]{7}$`) AND points to an existing document in `to` collection. The existence check happens at write time inside the same transaction; missing ref throws `BriValidationError` code `'REF_NOT_FOUND'`.
- `'ref|string'` validates: matches `'ref'` if the value is in the ID pattern OR is any non-empty string otherwise.

#### 2.1.2 Collection-level options

```js
const KGTripleSchema = {
  // ...field definitions...
  
  $indexes: [
    ['subject_id', 'predicate'],          // compound; UC-G2
    ['object_id_or_literal'],             // single-field; UC-G1 reverse
    ['source_session_id', 'superseded_by_id'],  // UC-X2 + filter
  ],
  
  $supersession: 'superseded_by_id',
  $confidence:   'confidence',
  $provenance:   'provenance_turn_ids',
  
  $edge: {
    from:        'kgEntity',
    to:          'kgEntity | string',
    predicate:   'predicate',  // field name; values may be open ('*') or enumerated
    predicates:  '*',          // or: ['works_at', 'lives_in', ...]
    symmetric:   false,
    unique:      false,        // if true, (from, to, predicate) is unique → upsert semantics
  },
};
```

| Schema key | Purpose | Effect on proxy |
|---|---|---|
| `$indexes` | Engine maintains specified secondary indexes; persisted in WAL on every write | Query planner uses them; queries that match prefix of an index hit O(log n) |
| `$supersession` | Names the field used for supersession backref | Default reads filter `WHERE field IS NULL`; opt-in via `.history` / `.asOf(t)` |
| `$confidence` | Names the field carrying numeric confidence | Enables `.confidence(threshold)` chain method on reads |
| `$provenance` | Names the field carrying provenance turn IDs (or any provenance ID) | Enables `.withProvenance` chain method that hydrates into `$provenance` metadata |
| `$edge` | Marks the collection as an edge collection, names endpoint and predicate fields | Enables predicate-access proxy: `from.{predicate}(to, attrs)` writes; `from.{predicate}` reads |

For nodes (non-edge collections) that participate in edges, no schema change is needed beyond their own collection's existence — the edge schema's `from` / `to` references make the wiring.

For session-cascade scope:

```js
source_session_id: { type: String, cascadeOn: 'session' }
```

The `cascadeOn: 'session'` flag opts the document into `db.cascade.session(id)` semantics. Knowledge collections leave the flag off. Future scopes (e.g., `'tenant'`) work identically — just declare and call `db.cascade.tenant(id)`.

#### 2.1.3 Edge collection inference

A collection is an edge collection if any of:
1. It has an explicit `$edge` block in its schema.
2. It has exactly two `'ref'` (or `'ref|string'`) fields and the schema author has registered the collection via `db.schema.declareEdge(collectionName, options)` at startup.

Default behavior when `$edge` is implicit: the engine picks the two ref fields as `from` and `to` in declaration order. If a `'predicate'`-typed string field is present, it becomes the predicate. If no predicate field, the edge is treated as relation-typed (single semantic relationship — e.g., `lexicalEdge`'s co-occurrence).

The implementer SHOULD prefer explicit `$edge` blocks in the documentation examples to avoid implicit-magic surprises. The inference is provided so existing schemas don't need rewrites.

#### 2.1.4 Schema load-time validation

The schema loader (extended for this work) MUST throw at startup, not at query time, on:

- Predicate vocabulary entry collides with a reserved proxy name (§0.4).
- Ref field's `to` collection has no schema registered.
- `$edge.from` or `$edge.to` field is not declared as a `ref` or `ref|string`.
- `$supersession` field is not declared on the collection (or is not a `ref` to the same collection).
- `$confidence` field is not declared as `Number`.
- Compound index references a field not declared on the collection.
- `cascadeOn` value is not a string scope name (validators may register known scopes).

Error class: `BriSchemaError`. Codes documented in §6.4.

### 2.2 Read query chain

The collection accessor `db.get.{collection}S` returns a chainable query builder when accessed without invocation; it executes when awaited or `.toArray()` is called.

```js
const results = await db.get.memoryArtifactS
  .where({ type: 'fact', superseded_by_id: null })   // attribute filter
  .near(queryVec, 20)                                // vector similarity
  .toArray();

// Equivalent terminal forms:
const results = await db.get.memoryArtifactS.where(...).near(queryVec, 20);
const first = await db.get.memoryArtifactS.where(...).near(queryVec, 20).first();
```

Chainable methods:

| Method | Signature | Purpose | UC |
|---|---|---|---|
| `.where(filter)` | `(obj \| fn) → query` | Attribute filter; object form compiles to index lookups when possible, fn form is scan + filter (composes with `.near` to filter during HNSW traversal) | V1, V2, X1 |
| `.near(vec, k)` | `(Array<number>, number) → query` | Top-k cosine similarity over the collection's `'vector'` field | V1, V2, V3 |
| `.match(stringFilter, k?)` | `({ field: query }, number?) → query` | Substring or full-string match on string fields; UC-V3 alias side, UC-X4 FTS | V3, X4 |
| `.combine(weights)` | `({alias: number, vector: number}) → query` | Weighted blend of `.match` + `.near` scores; both must precede | V3 |
| `.touching(seedIds)` | `(Array<string>) → query` | For edge collections: returns edges where any `from`/`to` field references any seed | G1 |
| `.confidence(threshold)` | `(number) → query` | Filter to docs with `$confidence >= threshold`; available iff schema declares `$confidence` | G1, G2, G6 |
| `.history` | property → query | Include superseded documents; available iff schema declares `$supersession` | G4 |
| `.asOf(timestamp)` | `(Date \| number) → query` | Point-in-time view; available iff schema declares `$supersession` | future |
| `.withProvenance` | property → query | Hydrate `$provenance` metadata onto results; available iff schema declares `$provenance` | G1 |
| `.hydrate(fields)` | `(Array<string>) → query` | Resolve named ref fields in a single round-trip | X1 |
| `.limit(n)` | `(number) → query` | Cap result count; redundant with `.near(vec, k)` but useful for `.where`-only queries | all |
| `.count()` | `() → Promise<number>` | Terminal; returns count of matching docs | X3 |
| `.distinct(field)` | `(string) → Promise<Array>` | Terminal; returns distinct values of a field | X3 |
| `.groupBy(field)` | `(string) → groupedQuery` | Continues with `.count()`, `.sum(field)`, `.having(filter)` | X3, G5 |
| `.toArray()` | `() → Promise<Array<entity>>` | Terminal; explicit form (chain is also thenable so `await` works) | all |
| `.first()` | `() → Promise<entity \| null>` | Terminal; returns first or null | all |

**Filter object semantics for `.where(obj)`:**

```js
{ field: value }                  // equality
{ field: null }                   // IS NULL
{ field: { $ne: value } }         // not equal
{ field: { $in: [v1, v2] } }      // in
{ field: { $gte: n, $lt: m } }    // range
{ field: { $exists: true } }      // exists / not null
```

Compound `AND` is implicit. `OR` via `{ $or: [filterA, filterB] }`. The query planner picks indexes that cover index prefix; falls back to scan otherwise.

**Score / metadata fields on results:**

- `.near(vec, k)` attaches `$cosine` and `$score` (where `$score === $cosine` if no `.combine` was applied).
- `.match(...)` attaches `$matchHits: { field: 'aliases', value: 'API gateway' }`.
- `.combine(weights)` attaches `$score` as the weighted blend; preserves `$cosine` and `$matchHits`.
- `.withProvenance` attaches `$provenance: [...turnIds]`.

These are non-persisted, attached via the entity proxy. Excluded from `entity.toObject()` unless `{includeMeta: true}` passed.

### 2.3 Predicate proxy (write side)

For any node entity whose collection is a valid endpoint of an edge collection, predicate names registered on that edge are exposed as proxy methods.

```js
// Schema:
schema.declareEdge('kgTriple', {
  predicates: ['works_at', 'lives_in', 'authored', /* ... */],
  from: 'kgEntity', to: 'kgEntity | string',
});

// Write:
await alice.works_at(acme, { confidence: 0.9, source_session_id: sid });
//   subject  predicate  object  edge attributes (excluding from/to/predicate)
```

Behavior:
1. Proxy looks up `works_at` on the entity.
2. Engine sees it's a registered predicate on `kgTriple` where `kgEntity` is a valid `from`. Yes → proxy returns a callable.
3. Calling with `(target, attrs)`:
   - Validates `target` against the edge's `to` constraint.
   - Constructs the edge document: `{ subject_id: alice.$ID, predicate: 'works_at', object_id_or_literal: target.$ID, ...attrs }`.
   - If `$edge.unique` is true, attempts upsert: looks up existing edge by the unique constraint; if found, applies a per-schema-defined merge function (default: shallow merge with attrs). If not found, inserts.
   - If not unique, always inserts.
4. Honors active transaction.
5. Returns a `Promise<entity>` resolving to the (new or upserted) edge document.

For symmetric edges (`$edge.symmetric: true`): the proxy normalizes the endpoint pair (sorts by `$ID` lexicographically) so `a.coOccursWith(b, attrs)` and `b.coOccursWith(a, attrs)` produce the same canonical edge.

For polymorphic objects (`$edge.to: 'kgEntity | string'`): if `target` is an entity, store its `$ID`. If `target` is a primitive string, store the string. Validate accordingly.

### 2.4 Predicate proxy (read side)

```js
// Read targets (resolved entities or literal strings):
const employers = await alice.works_at;        // → [acme, initech, ...]

// Read edges themselves (with attributes, scores, supersession state):
const employmentEdges = await alice.works_at.$;  // → [edge1, edge2, ...]

// Inverse (who works at acme?):
const employees = await acme.inverse.works_at;   // → [alice, bob, ...]
const inverseEdges = await acme.inverse.works_at.$;

// Combined predicates (all relations from this entity):
const allRelations = await alice.related;        // → flat list of targets, all predicates
const allEdges = await alice.related.$;          // → all edge docs

// With chain methods (only available if schema declares the corresponding fields):
const trustworthy = await alice.works_at.confidence(0.8);
const auditable = await alice.works_at.withProvenance;
const historical = await alice.works_at.history;       // includes superseded
const atTime = await alice.works_at.asOf(lastWeek);
```

**Default-applied filter:** when `$supersession` is declared on the edge collection, predicate reads filter `WHERE $supersession IS NULL` by default. `.history` opts out of this filter. `.asOf(t)` substitutes the as-of-time predicate.

**Multi-hop predicate chaining:** chained predicate access on Promise-of-array-of-entities flattens through the engine:

```js
// "Alice's employers' founders":
const founders = await alice.works_at.founded_by;
// Internally: BFS one hop on works_at, flatten, BFS one hop on founded_by, deduplicate.
```

Cycle detection: per-chain visited-set. Termination: chain length determines hops (no implicit budget — the call site decided how many to write).

For unbounded or parameterized expansion, see §2.6 (`.expand`).

### 2.5 Reference chain walks

For self-referential ref fields (supersession, lineage, parent-of-parent):

```js
// UC-G4 — supersession history walk (backwards):
const history = await triple.chain.supersedes_id;
// → [triple, prior, prior_prior, ...] in chain order, ends at null

// Forward walk:
const newer = await triple.chain.superseded_by_id;
```

Behavior:
- `.chain.{field}` requires `field` to be a `'ref'` declared on the same collection (self-reference). Throws `BriProxyError` code `'CHAIN_CROSSES_COLLECTION'` otherwise.
- Cycle detection: visited-set on `$ID`. On cycle detection, walk stops and returns `{ chain: [...], cycleDetected: true }` instead of a flat array. Wrap in `Array.isArray` check or destructure pattern.
- Hard cap: 10,000 hops by default (configurable per call: `entity.chain.field({ maxDepth: 100 })`). Exceeding cap returns `{ chain: [...], truncated: true }`.

### 2.6 Multi-hop expansion (parameterized graph traversal)

```js
const neighbourhood = await alice.expand({
  via: 'kgTriple',                         // edge collection (required)
  hops: 2,                                 // hop budget
  budget: { results: 100, ms: 25 },        // soft caps
  edgeFilter: { superseded_by_id: null },  // applied per-hop
  predicates: ['works_at', 'authored'],    // optional whitelist
  direction: 'out',                        // 'out' | 'in' | 'both' (default 'both')
});
// → {
//     nodes: [...entities],
//     edges: [...edge documents],
//     paths: [[seedId, edgeId, nodeId, edgeId, nodeId], ...],
//     complete: boolean,            // false if budget exhausted
//     incompleteReason: 'time' | 'results' | undefined,
//   }
```

Cycle handling: visited-set across nodes, enforced per traversal. Edges are not deduplicated across paths (a path-deduped result loses information).

### 2.7 Graph algorithms (parameterized, explicit namespace)

```js
// UC-G7 — Personalized PageRank
const top = await db.algo.ppr({
  seeds:        [alice, bob],         // entity instances or IDs
  via:          'kgTriple',           // edge collection
  k:            20,                   // top-k by stationary mass
  damping:      0.85,                 // default
  iterations:   15,                   // fixed; convergence is v3 refinement
  edgeFilter:   { superseded_by_id: null },
  edgeWeight:   (edge) => edge.confidence * Math.log(edge.retrieval_count + 1),
});
// → [{ entity, score }, ...] sorted by score desc

// UC-G5 — degree centrality
const central = await db.algo.degree({
  collection:   'lexicalEntity',
  via:          'lexicalEdge',
  weighted:     'co_occurrence_count',  // edge field name; if absent, unweighted count
  top:          50,
});
// → [{ entity, degree }, ...]
```

`db.algo` is its own namespace deliberately. These are not proxy-accessible because parameter-rich; they read as algorithms not as property access.

### 2.8 Cascade

```js
// Schema-declared scope cascade:
await db.cascade.session(sessionId);
// → bulk-deletes from every collection where any field is declared with cascadeOn: 'session'
//   atomic per collection; option for cross-collection atomicity in a single transaction:

await db.cascade.session(sessionId, { atomic: true });
// → opens a transaction internally, runs all per-collection deletes, commits or rolls back together

// Explicit list (escape hatch):
await db.cascade.byField({
  collections: ['memoryArtifact', 'lexicalEntity'],
  filter:      { source_session_id: sessionId },
});
```

Cascade routine MUST:
- Skip collections that don't carry a field with the named scope (knowledge tier is invisible to `cascade.session`).
- Roll back any in-flight transaction belonging to the cancelled session as part of the cascade.
- NOT delete documents staged inside another (non-cancelled) session's transaction.
- Run vector and graph index removals atomically with document deletes.
- Be idempotent (calling `cascade.session(X)` twice is a no-op the second time).

### 2.9 Aggregation

```js
// Count:
const total = await db.get.memoryArtifactS.where({ type: 'fact' }).count();

// Distinct:
const sessions = await db.get.memoryArtifactS
  .where({ type: 'fact', usage_count: { $gte: 3 } })
  .distinct('source_session_id');
// → ['SESS_abc', 'SESS_def', ...]

// Group by:
const byType = await db.get.memoryArtifactS
  .where({ promoted_at: null })
  .groupBy('type')
  .count();
// → [{ type: 'fact', count: 47 }, { type: 'preference', count: 12 }, ...]

// Group by + sum + having:
const popular = await db.get.lexicalEdgeS
  .groupBy('node_a')
  .sum('co_occurrence_count')
  .having({ sum: { $gte: 10 } });
// → [{ node_a: 'LEEN_abc', sum: 47 }, ...]
```

### 2.10 Search-result entity shape

A document returned from `.near` / `.match` / `.combine` / `.withProvenance` is the same reactive entity Bri already produces, with non-persisted metadata fields:

```js
const [first] = await db.get.memoryArtifactS.near(vec, 1);
first.$ID            // 'MEAR_abc1234'
first.type           // 'fact'
first.embedding      // [0.1, 0.2, ...]
first.$cosine        // 0.91
first.$score         // 0.91 (or weighted blend if .combine applied)
first.$matchHits     // undefined unless .match was applied
first.$provenance    // undefined unless .withProvenance was applied

first.toObject();    // standard body, no $-prefixed fields
first.toObject({ includeMeta: true });  // includes $cosine, $score, $matchHits, $provenance
first.save();        // works as usual; $-prefixed fields ignored on persist
```

### 2.11 Errors

All error classes extend `BriError` (existing). New codes for this work:

| Code | Class | Thrown when |
|---|---|---|
| `VECTOR_DIMS_MISMATCH` | `BriValidationError` | Embedding length doesn't match schema `dims` |
| `VECTOR_INVALID_VALUE` | `BriValidationError` | NaN, Infinity, or non-finite in embedding |
| `VECTOR_QUERY_DIMS_MISMATCH` | `BriQueryError` | Query vector to `.near` doesn't match collection's vector field dims |
| `VECTOR_FIELD_NOT_DECLARED` | `BriQueryError` | `.near` called on collection with no vector field in schema |
| `REF_NOT_FOUND` | `BriValidationError` | Ref field points to a non-existent doc |
| `EDGE_ENDPOINT_INVALID` | `BriValidationError` | Edge `from`/`to` doesn't match declared collection constraint |
| `PREDICATE_NOT_REGISTERED` | `BriProxyError` | Accessing `entity.{name}` where name isn't a registered predicate, ref, reserved method, or attribute |
| `CHAIN_CROSSES_COLLECTION` | `BriProxyError` | `.chain.{field}` where field's `to` is a different collection |
| `RESERVED_NAME_COLLISION` | `BriSchemaError` | Predicate or ref-field-name collides with a reserved proxy method |
| `CASCADE_SCOPE_UNKNOWN` | `BriSchemaError` | `db.cascade.{scope}` called for a scope no schema declares |
| `INDEX_FIELD_NOT_DECLARED` | `BriSchemaError` | Compound index references an undeclared field |
| `WAL_INDEX_REPLAY_FAILED` | `BriRecoveryError` | WAL replay couldn't reconstruct index state |

---

## 3. Implementation plan by file

This section enumerates every file that changes, every file created, and what each change does. Use this as the PR checklist.

### 3.1 New files

#### `engine/vector-index.js`

Module responsibility: in-process vector index. Pure-JS HNSW for v1. Pluggable interface (swap for native binding in v2).

Exports:
```js
class VectorIndex {
  constructor({ dims, metric = 'cosine', M = 16, efConstruction = 200, efSearch = 50 }) {}
  add(id, vector, { txnId } = {}) {}
  remove(id, { txnId } = {}) {}
  search(queryVector, k) {}
  searchFiltered(queryVector, k, predicate) {}  // predicate(id) → boolean, applied DURING traversal
  serialize() {}                  // returns Buffer; for snapshot
  static deserialize(buffer) {}
  commit(txnId) {}                // clears pending markers
  rollback(txnId) {}              // removes pending entries for this txn
  stats() {}                      // { count, pending, memoryBytes }
}
```

Key requirements:
- Pure JS, `Float32Array`-backed storage.
- Tombstone semantics: entries added under `txnId` are searchable only inside that txn; `commit` clears the marker; `rollback` removes the entry and its neighbour links.
- `searchFiltered` predicate runs during graph traversal, not post-filter. This is critical for UC-V1 acceptance criterion 3.
- All public methods documented with JSDoc including `@throws` for every typed error.
- Top-of-file docblock explains the algorithm choice, the tombstone strategy, and the v2 native-acceleration interface contract.

#### `engine/secondary-index.js`

Module responsibility: schema-declared secondary indexes. B-tree-style ordered index over one or more fields per collection. Maintained synchronously on every write.

Exports:
```js
class SecondaryIndexManager {
  declare(collection, indexSpec) {}  // indexSpec: ['field1', 'field2']
  insert(collection, doc) {}
  remove(collection, doc) {}
  update(collection, oldDoc, newDoc) {}
  lookup(collection, indexSpec, key) {}        // exact match
  range(collection, indexSpec, gte, lt) {}     // range
  prefix(collection, indexSpec, prefix) {}     // partial-key match (UC-G2)
  serialize() {}
  static deserialize(buf) {}
}
```

#### `engine/graph-index.js`

Module responsibility: adjacency materialization. For every edge collection, maintain forward and inverse adjacency maps: `nodeId → [edgeIds]`. Maintained on every edge write.

Exports:
```js
class GraphIndex {
  declareEdge(collection, edgeSpec) {}  // edgeSpec: { from, to, predicate, symmetric }
  insertEdge(collection, edgeDoc) {}
  removeEdge(collection, edgeDoc) {}
  outgoing(nodeId, collection, predicate?) {}
  incoming(nodeId, collection, predicate?) {}
  related(nodeId, collection?) {}        // both directions, all predicates
  serialize() {}
  static deserialize(buf) {}
}
```

#### `engine/query-planner.js`

Module responsibility: turn a `QueryBuilder` chain into an execution plan. Pick indexes that cover `.where` clause prefixes; fall back to scan; orchestrate vector search + filter composition.

Exports:
```js
class QueryPlanner {
  constructor(schemas, indexes, vectorIndices, graphIndex) {}
  plan(queryAst) {}      // returns ExecutionPlan
  execute(plan) {}       // returns Promise<results>
}
```

#### `client/query-builder.js`

Module responsibility: the chainable query API. Each method returns a new builder (immutable chain). Terminal methods produce a Promise.

Exports:
```js
class QueryBuilder {
  // Constructed by the proxy on db.get.{collection}S access.
  constructor(db, collection) {}
  
  where(filter) {}
  near(vec, k) {}
  match(stringFilter, k) {}
  combine(weights) {}
  touching(seedIds) {}
  confidence(threshold) {}
  hydrate(fields) {}
  limit(n) {}
  
  // Schema-conditional:
  get history() {}
  asOf(t) {}
  get withProvenance() {}
  
  // Aggregation:
  count() {}
  distinct(field) {}
  groupBy(field) {}        // returns GroupedQueryBuilder
  
  // Terminal:
  toArray() {}
  first() {}
  then(onResolve, onReject) {}  // makes await work directly
}

class GroupedQueryBuilder {
  count() {}
  sum(field) {}
  having(filter) {}
  toArray() {}
}
```

#### `client/predicate-proxy.js`

Module responsibility: the proxy resolution algorithm for predicate access on entities. Single source of truth for the lookup-order rules in §3.5.

Exports:
```js
function makeEntityProxy(rawDoc, db, collection) {}
function resolvePropertyAccess(target, prop, db) {}  // the lookup algorithm
```

The lookup algorithm (encoded in `resolvePropertyAccess`):

```
Given an entity proxy and a property access `entity.{name}`:

1. If name starts with '$' or is a known instance method (toObject, save, etc.):
   → return the actual property/method.
2. If name is in the reserved set (`history`, `asOf`, `chain`, `expand`, ...):
   → return the reserved-method handler bound to this entity.
3. If name === 'and':
   → return existing AndProxy (preserves backwards-compat single-hop ref population).
4. If name === 'inverse':
   → return InversePredicateProxy (next access is treated as inverse predicate).
5. If name === 'related':
   → return RelatedProxy (returns all predicates flattened).
6. If name is a declared field on this collection:
   → return the raw field value (existing behavior).
7. If name is a registered predicate where this collection is a valid `from` endpoint:
   → return PredicateAccessor (callable for write, awaitable for read).
8. Otherwise:
   → throw BriProxyError code 'PREDICATE_NOT_REGISTERED' with a helpful message
     listing valid options on this entity's collection.
```

Order matters: reserved names beat predicates, so a predicate named `history` would fail schema validation at load (per §0.4) before it ever reaches a proxy access.

### 3.2 New worker file

#### `workers/index-worker.js`

Module responsibility: holds the live `VectorIndex` and `GraphIndex` instances. Receives operations via `MessageChannel`, executes, returns results.

Operations supported:
- `vector.add { collection, id, vector, txnId }`
- `vector.remove { collection, id, txnId }`
- `vector.search { collection, vector, k, predicateFn? }` — predicate is serialized as a JS source string and `eval`'d in the worker (with sanitization)
- `vector.commit { collection, txnId }`
- `vector.rollback { collection, txnId }`
- `graph.expand { seedIds, via, hops, budget, edgeFilter, direction }`
- `algo.ppr { ... }`
- `snapshot.serialize` → returns serialized index state
- `snapshot.deserialize { buffer }`

Worker boundary contract:
- Only IDs and primitive scalars cross. Main thread hydrates IDs into entities.
- Worker has read-only access to documents via a request-response (`fetchDocs { ids }`) channel; it does NOT run reactive entity logic.

### 3.3 Modified files

#### `utils/schema.js`

Extensions:
- Add support for `'vector'`, `'ref'`, `'ref|string'`, `'predicate'` types.
- Add collection-level handlers for `$indexes`, `$supersession`, `$confidence`, `$provenance`, `$edge`.
- Add `cascadeOn` field option.
- Add schema load-time validation per §2.1.4.

Documentation impact: extensive. Every new type, every new collection-level option, every new error code documented inline with JSDoc. Top-of-file docblock updated with the new declaration vocabulary.

#### `engine/index.js`

Extensions:
- Wire in `SecondaryIndexManager`, `GraphIndex`, and `VectorIndex` (one per vector-bearing collection).
- Route writes through index updates (synchronous secondary + adjacency; vector via worker channel).
- Extend the `add`/`set`/`del` operations to journal index deltas in WAL records.
- Extend recovery to replay WAL into indexes on boot.

#### `engine/middleware.js`

Extensions:
- Transaction middleware now also tags index ops with `txnId`.
- New built-in: `cascadeMiddleware` for routing `db.cascade.{scope}(id)` calls.

#### `client/proxy.js` (or wherever the `db.get` proxy lives)

Extensions:
- `db.get.{collection}S` now returns a `QueryBuilder` when accessed without invocation; preserves existing call-form `db.get.userS(...)` for backwards compat.
- Entity proxies route through `resolvePropertyAccess` for predicate access.
- New top-level proxies: `db.cascade`, `db.algo`, `db.schema`.

#### `engine/entity.js` (or wherever reactive entities are constructed)

Extensions:
- Result entities from `.near`, `.match`, etc. carry `$score`, `$cosine`, `$matchHits`, `$provenance` as non-enumerable properties.
- `toObject({includeMeta: true})` opts-in to including those fields.

#### `storage/inhouse/wal.js`

Extensions:
- New WAL record types: `INDEX_INSERT`, `INDEX_REMOVE`, `INDEX_UPDATE`, `VECTOR_ADD`, `VECTOR_REMOVE`, `VECTOR_COMMIT_TXN`, `VECTOR_ROLLBACK_TXN`.
- Backwards-compatible: existing record types unchanged. Old WALs replay correctly into the new engine.

#### `storage/inhouse/snapshot.js`

Extensions:
- Snapshot format now includes serialized index state (vector indices and graph index). Format-versioned; old snapshots load and rebuild indexes from documents on first boot.

#### `storage/inhouse/index.js`

Extensions:
- On boot: if snapshot has indexes, deserialize them; replay WAL on top including index ops.
- If snapshot lacks indexes (old format), rebuild from documents (one-time cost).

#### `index.d.ts`

Extensions: full TypeScript surface for everything in §2. Approximately ~400 lines of new type declarations.

#### `tests/e2e/`

New test files (§5).

### 3.4 Documentation files (markdown deliverables under `docs/`)

The implementer creates these as part of the PR. Each file is ~200–600 lines.

| File | Contents |
|---|---|
| `docs/README.md` | Index of capability areas with one-paragraph summary + link |
| `docs/schema-extensions.md` | Full schema vocabulary: every new field type, every collection-level option, every flag, with worked examples |
| `docs/vector.md` | UC-V1..V5 walkthroughs with runnable examples; embedding generation explicitly out of scope; troubleshooting (dims mismatch, etc.) |
| `docs/graph.md` | UC-G1..G7 walkthroughs; predicate proxy mechanics; the proxy resolution algorithm explained; multi-hop chaining vs `.expand` |
| `docs/transactions.md` | Updated existing transactions doc to cover vector + graph atomicity, the tombstone approach (user-visible behavior, not implementation), `nop`/`pop` guarantees |
| `docs/cascade.md` | UC-X2 walkthrough; the `cascadeOn` schema flag; how to declare new scopes |
| `docs/aggregation.md` | UC-X3 walkthroughs |
| `docs/fts.md` | UC-X4 walkthrough |
| `docs/proxy-conventions.md` | The full lookup algorithm for entity property access; reserved names list; collision rules; how to debug "why did `entity.foo` throw" |
| `docs/migration.md` | How existing Bri schemas adopt vector + graph: minimal changes for backwards compat, full migration to predicate proxy |
| `docs/observability.md` | Scribbles integration; what gets logged and at what level |
| `README.md` | Top-level update: brief mention of vector + graph, link to docs/ |

### 3.5 Inline code documentation requirements (binding)

Every new module and every modified module must contain:

1. **Top-of-file docblock** (≥ 5 lines): describes the module's responsibility, where it sits in the architecture, and any non-obvious design decisions.
2. **Class JSDoc** for every exported class: `@class`, one-paragraph description, links to relevant docs/.
3. **Method JSDoc** for every public method: `@param` for each argument with type and description, `@returns`, `@throws` for every typed error the method can throw, `@example` for any non-trivial method.
4. **Inline comments** explaining any non-obvious algorithmic choice, race-window mitigation, or invariant being preserved. The goal is "next reader understands the why in five seconds." No commented-out code; no "TODO: explain later."
5. **Linkage** to the requirements UC: where a method directly implements a UC, the JSDoc includes `@implements UC-X1` etc.

Linting: a custom JSDoc-coverage script in `scripts/jsdoc-check.js` runs in CI and fails the build on any public exported function lacking a docblock.

---

## 4. Acceptance criteria mapping

Every UC in the requirements has a binding test or set of tests. Implementation is complete only when all map.

| UC | Test file | Test names | Performance gate |
|---|---|---|---|
| UC-V1 | `tests/e2e/vector.test.js` | `topK_with_filter_before_truncation`, `cosine_score_returned`, `wrong_dims_throws_typed_error`, `empty_collection_returns_empty`, `full_body_returned_no_round_trips` | < 50ms p95 over 100k vectors (v2 gate) |
| UC-V2 | `tests/e2e/vector.test.js` | `near_neighbour_with_threshold`, `read_consistent_inside_txn`, `read_consistent_outside_txn` | < 5ms p95 (v2 gate) |
| UC-V3 | `tests/e2e/vector.test.js` | `combined_alias_and_embedding`, `null_embedding_eligible_via_alias`, `audit_trail_components_returned` | < 30ms p95 over 20k entities (v2 gate) |
| UC-V4 | `tests/e2e/vector-tx.test.js` | `nop_leaves_index_pristine`, `pop_undoes_last_vector_write`, `crash_recovery_to_pre_txn_state`, `staged_write_visible_inside_txn_only` | n/a |
| UC-V5 | `tests/e2e/bulk.test.js` | `bulk_10k_does_not_block_request_path`, `partial_visibility_during_bulk`, `failure_mid_bulk_consistent_state` | < 30s for 10k vectors (off-request) |
| UC-G1 | `tests/e2e/graph.test.js` | `one_hop_seeds_to_triples`, `filter_predicates_apply`, `top_k_by_score`, `single_round_trip_with_hydration` | < 30ms p95 over 100k triples (v2) |
| UC-G2 | `tests/e2e/graph.test.js` | `partial_match_subject_predicate`, `self_edges_handled`, `compound_index_used` | < 10ms p95 (v2) |
| UC-G3 | `tests/e2e/graph.test.js` | `lexical_edge_lookup_unordered_pair`, `upsert_increments_count`, `appends_session_if_new` | n/a |
| UC-G4 | `tests/e2e/graph.test.js` | `chain_walk_terminates_on_null`, `chain_walk_detects_cycles`, `chain_walk_both_directions` | n/a |
| UC-G5 | `tests/e2e/graph.test.js` | `degree_centrality_weighted`, `bulk_edge_delete_atomic`, `dangling_ref_does_not_crash` | < 60s for 1M edges (off-request) |
| UC-G6 | `tests/e2e/graph.test.js` | `multi_hop_with_budget`, `cycles_dont_explode`, `partial_results_with_incomplete_flag` | n/a |
| UC-G7 | `tests/e2e/graph.test.js` | `ppr_seeded_top_k`, `edge_weights_honored`, `filter_predicates_apply_per_hop` | < 500ms p95 over 50k triples (v3) |
| UC-X1 | `tests/e2e/crosscutting.test.js` | `filter_plus_content_match_one_round_trip`, `hydrate_via_chain` | n/a |
| UC-X2 | `tests/e2e/cascade.test.js` | `cascade_session_deletes_marked_collections`, `knowledge_collections_immune`, `in_flight_other_session_txn_protected`, `cancelled_session_txn_rolled_back`, `cascade_idempotent` | < 200ms p95 |
| UC-X3 | `tests/e2e/aggregation.test.js` | `count_with_filter`, `count_distinct`, `group_by_count`, `group_by_sum`, `group_by_having` | full-collection scan over 1M < 2s (v3) |
| UC-X4 | `tests/e2e/fts.test.js` | `substring_match_returns_top_k`, `recency_tiebreak`, `fts_index_eventually_consistent` | n/a |

End-to-end scenarios from the requirements doc, §F:

| Scenario | Test file | Test name |
|---|---|---|
| Test 1 — round-trip insert/recall/dedup/supersede | `tests/e2e/scenarios.test.js` | `round_trip_memory_artifact_lifecycle` |
| Test 2 — knowledge graph triples + supersession + traverse | `tests/e2e/scenarios.test.js` | `knowledge_graph_triples_lifecycle` |

---

## 5. Test coverage

### 5.1 Test suites and what each covers

| Suite | UCs covered | Notes |
|---|---|---|
| `vector.test.js` | V1, V2, V3 (read-side) | Excludes transaction interaction |
| `vector-tx.test.js` | V4 | Stage-then-commit, nop/pop, crash recovery |
| `bulk.test.js` | V5 | Concurrency: bulk insert running while request-path reads execute |
| `graph.test.js` | G1, G2, G3, G4, G5, G6, G7 | Predicate proxy mechanics; multi-hop; PPR |
| `crosscutting.test.js` | X1 | Filter + content + ref hydration in one round trip |
| `cascade.test.js` | X2 | Cancellation cascade; transaction interaction; idempotence |
| `aggregation.test.js` | X3 | Count, distinct, groupBy, having |
| `fts.test.js` | X4 | Full-text search on ChatTurn-shaped collection |
| `proxy-resolution.test.js` | (cross-cutting) | Reserved names, predicate vs ref vs attribute, error messages, schema collision detection |
| `recovery.test.js` | (cross-cutting) | WAL replay including index ops, snapshot+WAL hybrid recovery, missing-snapshot rebuild |
| `scenarios.test.js` | (end-to-end) | Two scenarios from requirements §F |
| `scale.test.js` | (perf gates) | Latency budgets at v1, v2, v3 scale targets |

### 5.2 Test fixture requirements

Each suite uses an isolated `BRI_DATA_DIR`. Setup creates a fresh data directory; teardown wipes it. Tests are independent and order-insensitive.

A shared `tests/fixtures/` folder provides:
- `tests/fixtures/schemas.js` — `MemoryArtifactSchema`, `KGEntitySchema`, `KGTripleSchema`, `LexicalEntitySchema`, `LexicalEdgeSchema`, `ChatTurnSchema` matching V8 field names.
- `tests/fixtures/embeddings.js` — deterministic synthetic embeddings (seeded RNG, 1536-dim, normalized) for repeatable tests.
- `tests/fixtures/triples.js` — 100 KGEntity, 1000 KGTriple sample data for §F Test 2.

### 5.3 Performance tests

`scale.test.js` asserts the latency budgets in the requirements doc §D for each scale tier. Marked `@scale` so CI can run them on a perf-tier runner; `npm test` runs only correctness suites by default. `npm run test:scale` runs perf.

Perf tests use `process.hrtime.bigint()` for sub-ms accuracy; assert p95 over ≥1000 iterations.

### 5.4 Concurrency tests

`bulk.test.js` interleaves operations: a long-running `db.add.collectionS(tenThousandDocs)` runs in one async chain while the test fires repeated `.near` queries from another and asserts each completes within budget. Validates the worker offload is genuinely non-blocking.

### 5.5 Cancellation correctness tests

`cascade.test.js` includes:
- Cancel a session whose `rec()` is open and contains 5 in-flight memory artifact inserts. Assert `nop()` happens, all 5 vector-index entries are gone, no WAL entries reference them post-recovery (simulate crash + restart).
- Run `cascade.session(X)` while session Y has an open transaction touching one of the cascadeable collections. Assert Y's transaction is unaffected.

---

## 6. Phasing

Aligned to the requirements doc §D scale targets.

### 6.1 v1 — Phase 4a/4b (1k–10k scale, correctness gate)

Deliverables:
- Schema extensions §2.1 complete.
- Pure-JS HNSW (`engine/vector-index.js`) functional.
- Secondary indexes (`engine/secondary-index.js`) functional.
- Graph index (`engine/graph-index.js`) functional.
- Worker offload (`workers/index-worker.js`) functional.
- Query builder §2.2 complete except `.asOf` (defer to v2).
- Predicate proxy §2.3, §2.4 complete.
- Reference walks §2.5 complete.
- Multi-hop expand §2.6 complete.
- `db.algo.degree` complete; PPR (`db.algo.ppr`) defer to v3.
- Cascade §2.8 complete.
- Aggregation §2.9 complete.
- FTS §2.10 — basic substring match only; no stemming/stopwords.
- Transactions §2 — tombstone semantics complete; recovery tested.
- All tests in §5.1 pass at correctness level.
- All documentation §3.4 and §3.5 complete.

Acceptance: every UC test passes; every scenario test passes; latency targets are advisory at v1 scale, not gates.

### 6.2 v2 — Phase 4c (10k–100k scale, latency gate)

Deliverables:
- Latency budgets §D enforced as gates.
- Persistent secondary indexes (B-tree on disk for cold-tier collections).
- Adjacency index persistence (snapshot includes graph index).
- Optional native HNSW acceleration via USearch N-API binding, behind feature flag `BRI_VECTOR_NATIVE=usearch`. Pure-JS remains default.
- `.asOf(t)` chain method.
- FTS upgrades: stemming, stop-word filtering.

Acceptance: `scale.test.js` passes at 100k scale.

### 6.3 v3 — Phase 4d (1M scale + advanced graph)

Deliverables:
- `db.algo.ppr` complete with fixed-iteration default; convergence-based iteration as opt-in.
- 1M-vector index supported on a 16GB-RAM machine (verified).
- 1M-edge graph index supported.
- Transaction topology-journaling option (alternative to tombstones for very long transactions): off by default, opt-in via `db.config.transactionMode = 'journal'`.

Acceptance: `scale.test.js` passes at 1M scale; UC-G7 budget met.

---

## 7. Risks and escalation triggers

The following are pre-flagged. If any becomes blocking, surface for discussion before workaround.

### 7.1 Vector index recovery from WAL

**Risk:** HNSW topology is not deterministically reversible from "I inserted vector V" alone — neighbour links are rewritten on each insert, and undoing requires either restoring the prior topology or rebuilding from scratch.

**Mitigation in v1:** tombstone approach. Pending entries are logically marked, never linked into the searchable graph. `nop()` removes them (no topology damage). Recovery: after WAL replay, all pending markers from non-committed transactions are cleared; the index is consistent.

**Edge case:** a `pop()` that undoes a *committed-and-linked* vector entry inside a still-open transaction. Per existing Bri semantics, `pop()` undoes the last action regardless of commit state of prior actions; this means we need topology removal mid-transaction, not just tombstone clearing. The implementer can either: (a) defer all index linking until `fin()`, treating the entire txn's vector adds as a batch (simplest, slightly larger pending set during long txns), or (b) journal full neighbour-link deltas. Choose (a) for v1.

**Escalate if:** the v1 acceptance test for `pop()`-after-vector-add fails consistency check after recovery. Indicates the deferred-linking approach has a bug.

### 7.2 Predicate proxy collision with future reserved names

**Risk:** future Bri features may want method names that collide with predicates Ashlyn has already deployed.

**Mitigation:** the reserved-name list (§0.4) is a hard list, frozen as part of this delivery. Any future addition is a breaking change requiring a major version bump and a migration path. Document this contract loudly.

**Escalate if:** an Ashlyn schema in development needs a predicate from the reserved list. The fix is a schema-level rename (`works_at` is fine; `history` is not).

### 7.3 Worker thread overhead at small scale

**Risk:** at v1 scale (1k–10k vectors), the overhead of crossing the worker boundary may dominate the actual search time, making `.near` slower than a main-thread implementation would be.

**Mitigation:** the worker is invoked per-search, not per-document; even at 10k vectors the search itself is the dominant cost. If profiling shows otherwise, an opt-in main-thread mode (`BRI_VECTOR_WORKER=false`) is acceptable as v1 escape hatch.

**Escalate if:** v1 latency tests fail because of worker overhead, not algorithmic cost.

### 7.4 Schema migration for existing Bri users

**Risk:** existing Bri databases without schema have no way to opt into vector + graph features without first declaring schemas.

**Mitigation:** schema declaration is a one-time setup step; existing collections continue to work unchanged with the existing API. Vector + graph features simply require schema. Document the migration path in `docs/migration.md`.

**Escalate if:** a use case requires retrofit-without-schema. Likely a wrong-tool-for-job answer; defer to discussion.

### 7.5 PPR at 1M scale

**Risk:** PPR power iteration on a 1M-edge graph in a single worker may exceed the v3 budget (500ms over 50k — the budget is at 50k, scale to 1M is "separate scaling question").

**Mitigation:** v3 explicitly scopes PPR to the 50k-triple budget. Beyond that, scaling is a separate effort (likely sharded adjacency or sparse-matrix iteration with SIMD).

**Escalate if:** v3 scale targets demand PPR at 1M scale. Requires distinct design work.

---

## 8. Definition of done

The implementation is complete when ALL of the following hold:

1. Every test in §4 and §5 passes on a clean checkout (`npm install && npm test`).
2. `npm run test:scale` passes at v2 scale on a 16GB / 8-core development machine.
3. `npm run test:coverage` reports ≥ 90% line coverage on all new and modified files.
4. `scripts/jsdoc-check.js` reports zero undocumented public exports.
5. All markdown files in §3.4 exist, are reviewed for accuracy, and have working examples (each example block is exercised by a test).
6. `index.d.ts` covers the entire public surface of §2; `tsc --noEmit` against the type definitions and the test suite passes.
7. The two end-to-end scenarios from requirements §F are demonstrated end-to-end (E2E + illustrative snippets in `docs/illustrative-scenarios.md`; not a runnable `examples/` harness).
8. The recovery test (`recovery.test.js`) passes a `kill -9` mid-transaction simulated crash and restart, verifying index state is pre-transaction-clean.
9. `BRI_ENCRYPTION_KEY=... npm test` passes — encryption parity verified.
10. Cancellation invariant verified: `cascade.session(X)` followed by a full collection scan produces zero documents with `source_session_id === X` across all cascade-eligible collections.

---

## 9. What is explicitly out of scope

Per requirements §E, do NOT implement:

- Embedding generation (Ollama / cloud / local model invocation).
- Re-ranking logic (cosine × recency × confidence × log(usage) is computed by Ashlyn).
- The five-gate promotion pipeline (Ashlyn's job; Bri provides the queries).
- Critical-engagement directive composition (Ashlyn).
- Distance metrics other than cosine for v1 (cosine only).
- Vector quantization or PQ compression (implementer's tuning lever for v3 if useful, never user-visible).

If any of these are implemented anyway, the PR will be rejected. The substrate stays a substrate.

---

## 10. Final note

The requirements doc §F closes with:

> If any criterion is materially harder than expected, surface it for discussion before committing to a workaround — the V8 spec has a few places (Q19 merge thresholds, Q20 promotion thresholds, Q21 token budgets) where the calling agent can absorb tuning, but the **two-store invariant (V8 §3.6.0)** and the **cancellation cascade (V8 §3.6.11)** are non-negotiable.

This applies here. The non-negotiables are reflected in §0.3 of this doc and tested in `cascade.test.js` and `vector-tx.test.js`. Everything else is an implementer's tuning lever.

End of task.