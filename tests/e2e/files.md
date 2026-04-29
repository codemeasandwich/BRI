## Directory Structure

```
e2e/
├── aggregation.test.js
├── branch-coverage.integration.test.js
├── bulk.test.js
├── cascade.test.js
├── coverage-branches-100.integration.test.js
├── coverage-gaps.test.js
├── coverage-line-sweep.test.js
├── crud.test.js
├── diff.test.js
├── edge-cases.test.js
├── encryption.test.js
├── engine-vector-txn-buffers.test.js
├── errors.test.js
├── final-coverage.test.js
├── graph.test.js
├── hnsw-graph-resilience.integration.test.js
├── jss.test.js
├── match.test.js
├── memory.test.js
├── middleware.test.js
├── persistence.test.js
├── proxy-resolution.test.js
├── pubsub.test.js
├── query-builder-chain.test.js
├── reactive.test.js
├── recovery-child.mjs
├── recovery.test.js
├── scale.test.js
├── scenarios.test.js
├── schema.test.js
├── secondary-index.test.js
├── sets.test.js
├── smoke-cross-cutting.test.js
├── storage-client-public-branches.test.js
├── transactions.test.js
├── vector-recovery.test.js
├── vector-tx.test.js
├── vector-wal-recovery-child.mjs
├── vector.test.js
├── wal-record-types.test.js
└── worker.test.js
```

## Files

### `crud.test.js`
Basic CRUD operations - add, get, set, del for single and multiple documents.

### `persistence.test.js`
WAL replay and snapshot recovery after simulated crashes.

### `transactions.test.js`
Transaction operations - rec, fin, nop, pop with isolation testing.

### `middleware.test.js`
Middleware plugin system - use, remove, hooks, validation.

### `reactive.test.js`
Reactive proxy change tracking - save, nested changes, arrays.

### `pubsub.test.js`
Pub/sub subscription system - subscribe, publish, unsubscribe.

### `schema.test.js`
Schema validation - types, required fields, enums.

### `jss.test.js`
JSS serialization - Date, Error, Map, Set, circular references.

### `diff.test.js`
Diff utilities - change tracking, path operations, apply.

### `sets.test.js`
Collection operations - sAdd, sMembers, sRem.

### `edge-cases.test.js`
Boundary conditions - empty values, large objects, special characters.

### `errors.test.js`
Error handling - invalid inputs, missing data, constraint violations.

### `memory.test.js`
Memory management - eviction, cold tier promotion.

### `vector.test.js`
Vector search end-to-end (UC-V1) - top-k cosine similarity, filter composition, dimension validation, score metadata, legacy call-form back-compat, persistence (snapshot v3 + WAL replay), drift detection. Also covers v2 HNSW correctness gates: ≥0.95 top-10 recall at 1k, exact recall at fixture-scale (≤100), seeded-RNG bit-identical serialize() output, per-call efSearch override widens the candidate frontier, stats() exposes M/efConstruction/efSearch/entryLevel, replace-via-add overwrites cleanly, and the chain-API-level efSearch override flows from .near(v, k, { efSearch }) through query-builder to the index.

### `vector-tx.test.js`
Vector transaction integration (UC-V4) - staged-write isolation (visible inside txn, invisible outside via `.near` opts.txnId override), nop pristine, fin atomic commit, pop undoes last vector write, crash recovery to pre-txn state.

### `engine-vector-txn-buffers.test.js`
Exports from `package.json` → `./engine`: `VectorIndex` txn buffer edge cases (staged add/remove, merge search, predicate merges) and `BriError` `details` branching — validates the public `./engine` specifier without deep paths.

### `vector-recovery.test.js`
VectorIndex codec wire-format compatibility (v2 §6.2 HNSW upgrade) - v1-format buffers (no graph topology) deserialize cleanly and trigger one-shot rebuildTopology; v2 → v2 roundtrips are bit-identical; post-rebuild serialize emits v2; unsupported future versions are rejected with a diagnostic error; empty-index rebuild edge case; full DB lifecycle test that synthesizes a v1 snapshot file on disk, boots a real createDB, and verifies the rebuilt graph + post-upgrade snapshot is v2.

### `wal-record-types.test.js`
Canonical WAL vocabulary (`storage/wal/record-types.js`) exercised through helper predicates and WAL replay routing — document vs index vs vector tiers, silent skip on marker lines, noisy warn on genuinely unknown actions.

### `scale.test.js`
Scale latency gates (run via `npm run test:scale`; excluded from the default `npm test` path) - UC-V1 near() p95 over 5k vectors, UC-V2 near() with .where prefilter p95, UC-V3 combined match+near scoring p95 over 2k, UC-V5 bulk insert wall-clock at 2k. Each gate runs ~100 timed iterations after a 50-iter warmup using `process.hrtime.bigint()`.

### `smoke-cross-cutting.test.js`
Cross-cutting smoke tests - 5-doc snapshot+restart roundtrip, 1000-doc multi-collection $indexes prefilter through .where + .near.

### `graph.test.js`
Predicate proxy + edge collections (UC-G1) - one-hop predicate read returns outgoing targets, predicate filtering, full reactive-entity hydration, edge document write via `alice.works_at(target, attrs)`, reserved-name collision detection at schema load, .limit(k) bounded read, regression guard for collections without edges. Inverse predicate access (`acme.inverse.works_at`), .related across all predicates, and .$ for edge documents (forward + inverse + related) are gated by additional describe block. Multi-hop expand (UC-G6) covers hops/budget/cycles/direction/predicates filters, and degree centrality (UC-G5) covers count + weighted + top + dangling-adjacency resilience. UC-G4 reference chain walks cover forward/backward self-ref traversal, cycle detection, maxDepth cap, cross-collection rejection, and orphan handling. UC-G1 chain methods (.history / .confidence(t) / .withProvenance) cover default-supersession filtering, opt-out via .history, threshold filtering, $provenance metadata attachment, and absence-on-no-schema-flag. A dedicated GraphIndex block covers serialize/load round-trip, undeclared-collection inserts (no-op), relaxed edges without explicit predicate (`*` buckets), and end-to-end delete-through-middleware adjacency teardown.

### `cascade.test.js`
Schema-scoped cancellation cascade (UC-X2, §10 non-negotiable) - cascadeOn-flagged collection rows deleted by scope id, knowledge collections (no flag) immune, multi-collection cascade in one call, idempotent re-runs, vector + graph index consistency through cascaded deletes, other-session txn isolation, byField escape hatch, no-op safety on unknown scopes and empty registry.

### `aggregation.test.js`
Aggregation primitives (UC-X3) - .count() with and without filter, .distinct(field) with and without filter, .groupBy().count() / .sum(field) / .having(filter), and filter operator coverage ($gte/$gt/$lte/$lt/$ne/$in/$exists).

### `match.test.js`
Substring FTS (UC-X4) and combined alias+vector retrieval (UC-V3) - .match returns docs whose string field contains the query (case-insensitive), works on Array fields, attaches $matchHits metadata, respects top-k cap, recency tiebreak via updatedAt desc, composes with .where; .combine blends .match and .near scores per declared weights, null-embedding docs eligible via alias-only match, audit-trail components ($score / $cosine / $matchHits) on each result.

### `secondary-index.test.js`
Secondary indexes (engine portion of UC-X1) - SortedIndex unit roundtrips, $indexes schema declaration, compound prefix matching, non-prefix scan fallback, mutation consistency on insert/update/delete, undeclared-field rejection, persistence across restart, bounded hydration when combined with .near.

### `bulk.test.js`
Bulk write / throughput scenarios for vector path (UC-V5-oriented).

### `proxy-resolution.test.js`
Predicate proxy and entity property resolution edge cases.

### `query-builder-chain.test.js`
Chain builder — `.touching`, `.hydrate`, `.confidence`, `.history`, `.withProvenance`, typed errors, and terminal helpers (`.first`, `.count`, `.distinct`) including near-incompatibility guards and de-duplicated distinct scans.

### `recovery.test.js`
Snapshot + WAL recovery for vector/graph index state; spawns `recovery-child.mjs` when needed.

### `recovery-child.mjs`
Child-process helper for recovery tests (isolated db lifecycle).

### `scenarios.test.js`
End-to-end scenario matrix across vector + graph + cascade surfaces.

### `worker.test.js`
Opt-in vector index worker thread — `workerDiagnostics`, opCount.

### `coverage-gaps.test.js`
Additional test cases for uncovered code paths.

### `storage-client-public-branches.test.js`
Public `createStore` / `createDB` / `getDB` branching: env-driven `storeConfig`, explicit `storeType: 'inhouse'`, bundled defaults (`{}`, no-arg, `config: null`), `validateConfig` from `./storage`, cwd-relative `./data` when env is unset, and invalid `BRI_MAX_MEMORY_MB` fallback.

### `coverage-line-sweep.test.js`
Targeted clauses for instrumentation gaps: validator throws on query chains, cascade `byField` / `opts.atomic`, graph expand budgets and `direction: 'both'`, `loadVectorState` orphan schema, adapter `vectorEntries()`, `isPartialMatch` nesting, bounded index + residual + `.match`, and misc public surfaces.

### `branch-coverage.integration.test.js`
Integration flows targeting Istanbul branch arms via real `createDB` / storage paths (composite schemas, query-builder residuals, vector WAL routing).

### `coverage-branches-100.integration.test.js`
Focused harness for remaining rare branches (txn lifecycle, vector middleware graph/set guards, encrypted WAL helpers, HNSW `dropNode` re-election ties).

### `encryption.test.js`
Encrypted WAL segments (`serializeEntryEncrypted`), key plumbing, and round-trip recovery assertions.

### `hnsw-graph-resilience.integration.test.js`
HNSW topology resilience scenarios — lazy deletes, rebuild gates, and search correctness around mutated graphs.

### `vector-wal-recovery-child.mjs`
Child-process helper for vector tier WAL replay / recovery tests (`vector-recovery` companion).

### `final-coverage.test.js`
Final coverage sweep for remaining gaps.
