# Bri Documentation

Capability-area documentation for Bri features. Implementation reference lives next to the code in each module's `README.md` and `FILES.md`; the docs in this folder cover end-user surfaces and walkthroughs.

## Index

| Document | Covers |
|---|---|
| [vector.md](vector.md) | Vector search — schema declaration, chainable query builder (`.where().near()`), result metadata, errors, v1 limitations |
| [indexes.md](indexes.md) | Secondary indexes — `$indexes` schema option, planner behavior, bounded hydration when combined with `.near` |
| [graph.md](graph.md) | Knowledge graph — `$edge` schema, predicate proxy (`alice.works_at`), reserved-name collision detection, GraphIndex adjacency lookup |
| [cascade.md](cascade.md) | Cancellation cascade (§10 non-negotiable) — `cascadeOn` schema flag, `db.cascade.{scope}` API, two-store invariant, composition with V4 transactions |
| [aggregation.md](aggregation.md) | Aggregation — `.count`, `.distinct`, `.groupBy().count/.sum/.having`, filter operators ($gte, $in, $exists, etc.) |
| [fts.md](fts.md) | Substring FTS — `.match(stringFilter, k?)` and `.combine({alias, vector})` for blended alias + vector retrieval (UC-X4 + UC-V3) |

More capability-area docs (graph, transactions, cascade, aggregation, FTS, proxy conventions, migration, observability) land alongside their respective implementation slices.
