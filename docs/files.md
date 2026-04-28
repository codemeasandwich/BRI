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
└── vector.md
```

## Files

### `README.md`

Index of capability-area documents. Lists each document and its scope so readers can find the right walkthrough quickly.

### `files.md`

This index — explains the responsibility of every file in this directory.

### `vector.md`

End-user walkthrough of the vector-search surface (UC-V1 slice). Covers schema declaration, the chainable `db.get.{collection}S.where(...).near(...)` API, result metadata (`$cosine`, `$score`), error modes, backwards compatibility with the legacy callable form, persistence (snapshot v3 + WAL replay + drift detection), composition with secondary indexes, and v1 limitations with pointers to v2 follow-ups.

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
