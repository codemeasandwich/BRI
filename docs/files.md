## Directory Structure

```
docs/
├── README.md
├── files.md
├── aggregation.md
├── cascade.md
├── fts.md
├── graph.md
├── indexes.md
├── migration.md
├── observability.md
├── proxy-conventions.md
├── schema-extensions.md
├── transactions.md
└── vector.md
```

## Files

### `README.md`

Index of capability-area documents. Lists each document and its scope so readers can find the right walkthrough quickly.

### `files.md`

This index — explains the responsibility of every file in this directory.

### `vector.md`

End-user walkthrough of the vector-search surface. Covers schema declaration, the chainable `db.get.{collection}S.where(...).near(...)` API, result metadata (`$cosine`, `$score`), error modes, backwards compatibility with the legacy callable form, persistence (snapshot v3 + WAL replay + drift detection + index-format v1→v2 rebuild), composition with secondary indexes, transactions (UC-V4), and the HNSW algorithm with its tuning parameters (M / efConstruction / efSearch) and `BRI_VECTOR_RNG_SEED` determinism control.

### `indexes.md`

End-user walkthrough of secondary indexes. Covers the `$indexes` schema option (single-field and compound), how the QueryPlanner picks indexes, prefix matching semantics, bounded-hydration guarantees when combining `.where` with `.near`, mutation consistency, persistence behavior, and v1 limitations.

### `aggregation.md`

End-user walkthrough of aggregation primitives (UC-X3). Covers `.count` / `.distinct` terminals, the `.groupBy(field).count()` and `.groupBy(field).sum(field)` chains, `.having(filter)` post-aggregation filtering, the operator vocabulary ($gte, $gt, $lte, $lt, $ne, $in, $exists), how aggregation interacts with secondary indexes, and v1 limitations (no min/max/avg, no compose with .near, no multi-key groupBy).

### `fts.md`

End-user walkthrough of substring full-text search (UC-X4) and combined alias+vector retrieval (UC-V3). Covers the `.match(stringFilter, k?)` chain method (case-insensitive, string-or-array fields, `$matchHits` attribution, recency tiebreak), the `.combine({alias, vector})` weighted blend (formula, `null_embedding_eligible_via_alias` behavior, `$score`/`$cosine`/`$matchHits` audit trail), how match integrates with the QueryPlanner's `.where` prefilter, and v1 limitations (substring-only, no stemming/stopwords/fuzzy, inline scan, no persistent FTS index — all v2 deliverables per spec §6.2).

### `cascade.md`

End-user walkthrough of the cancellation cascade (UC-X2, §10 non-negotiable). Covers the cascadeOn schema flag, the two-store invariant (knowledge tier immunity), the API (db.cascade.{scope}, db.cascade.byField, opts.atomic, opts.txnId), composition with V4 transactions for idiomatic session cancellation, idempotence, return shape, and v1 limitations.

### `graph.md`

End-user walkthrough of the knowledge-graph surface (UC-G1 slice). Covers the `$edge` schema block (with the from/to-as-collection-constraint vs field-name semantics), predicate-name reserved list (§0.4) and collision detection, predicate access mechanics (`alice.works_at` for read, `alice.works_at(target, attrs)` for write), how writes flow through middleware, how reads use the GraphIndex for O(degree) lookup, and v1 limitations with pointers to follow-up slices (inverse, multi-hop, supersession, polymorphic refs).

### `schema-extensions.md`

Reference for the new schema vocabulary v1 introduces: the `'vector'` / `'ref'` / `'ref|string'` / `'predicate'` field types, the collection-level options (`$indexes`, `$supersession`, `$confidence`, `$provenance`, `$edge`), and field-level `cascadeOn`. Includes the reserved-name list and the schema load-time validation that rejects collisions.

### `transactions.md`

What `db.rec()` / `db.fin()` / `db.nop()` / `db.pop()` guarantee for vector + graph state, the deferred-linking transaction model from spec §7.1, and the cancellation cascade contract from spec §2.8 (including the in-flight txn rollback for the cancelled session). Lists the WAL record types added in v1.

### `proxy-conventions.md`

Reference for the spec §3.5 entity property-access lookup algorithm. Lists the reserved chain-method names, the precedence order (`$`-prefixed → `and` → reserved → `inverse` → `related` → declared field → predicate → throw), and a debugging guide for "why did `entity.foo` throw?".

### `migration.md`

How an existing Bri project adopts vector + graph: which existing surfaces still work unchanged, the four-step adoption path (declare schemas → opt-in to chain syntax → adopt predicate proxy → wire cascade scopes), the typed-error contract change (validator throws instead of returning `string|null`), and the worker-thread opt-in.

### `observability.md`

What gets logged, where to find diagnostic accessors, how to inspect the WAL by record type, and what the worker thread exposes via `workerDiagnostics()`. v1 is intentionally minimal — there is no metrics SDK, no tracing endpoint; this page documents the read-only signals available.
