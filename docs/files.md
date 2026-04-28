## Directory Structure

```
docs/
├── README.md
├── files.md
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

### `graph.md`

End-user walkthrough of the knowledge-graph surface (UC-G1 slice). Covers the `$edge` schema block (with the from/to-as-collection-constraint vs field-name semantics), predicate-name reserved list (§0.4) and collision detection, predicate access mechanics (`alice.works_at` for read, `alice.works_at(target, attrs)` for write), how writes flow through middleware, how reads use the GraphIndex for O(degree) lookup, and v1 limitations with pointers to follow-up slices (inverse, multi-hop, supersession, polymorphic refs).
