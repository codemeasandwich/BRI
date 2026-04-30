# Bri Documentation

Capability-area documentation for Bri features. Implementation reference lives next to the code in each module's `README.md` and `FILES.md`; the docs in this folder cover end-user surfaces and walkthroughs.

**Integration-test artifacts:** at the repository root, directories whose names begin with `test-data-` hold disposable WAL/snapshot output from Jest E2E. They are ignored by Git and deleted automatically after each full test run (`globalTeardown` in `jest.config.js`). Long-lived seeded files belong under `tests/fixtures/`, not under `test-data-*`.

## Index

| Document | Covers |
|---|---|
| [schema-extensions.md](schema-extensions.md) | Schema vocabulary — new field types (`vector`, `ref`, `ref|string`, `predicate`), collection-level options (`$indexes`, `$supersession`, `$confidence`, `$provenance`, `$edge`, `cascadeOn`), reserved-name collision rules |
| [vector.md](vector.md) | Vector search — schema declaration, chainable query builder (`.where().near()`), result metadata, errors, v1 limitations |
| [indexes.md](indexes.md) | Secondary indexes — `$indexes` schema option, planner behavior, bounded hydration when combined with `.near` |
| [graph.md](graph.md) | Knowledge graph — `$edge` schema, predicate proxy (`alice.works_at`), reserved-name collision detection, GraphIndex adjacency lookup |
| [transactions.md](transactions.md) | Transactions for vector + graph state — `rec/fin/nop/pop` guarantees, deferred-linking model (§7.1), cancellation cascade contract, WAL record types |
| [cascade.md](cascade.md) | Cancellation cascade (§10 non-negotiable) — `cascadeOn` schema flag, `db.cascade.{scope}` API, two-store invariant, in-flight txn rollback |
| [aggregation.md](aggregation.md) | Aggregation — `.count`, `.distinct`, `.groupBy().count/.sum/.having`, filter operators ($gte, $in, $exists, etc.) |
| [fts.md](fts.md) | Substring FTS — `.match(stringFilter, k?)` and `.combine({alias, vector})` for blended alias + vector retrieval (UC-X4 + UC-V3) |
| [proxy-conventions.md](proxy-conventions.md) | Entity property-access lookup algorithm (§3.5), reserved-name list, debugging "why did `entity.foo` throw?" |
| [migration.md](migration.md) | Adopting vector + graph in an existing Bri project — what still works, the four-step path, typed-error contract change |
| [illustrative-scenarios.md](illustrative-scenarios.md) | §F-style memory + kg walkthroughs as **non-executable** illustrative snippets only (tests are authoritative) |
| [observability.md](observability.md) | What gets logged, diagnostic accessors, WAL inspection, worker-thread `opCount` |
