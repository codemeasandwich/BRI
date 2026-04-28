## Directory Structure

```
e2e/
├── crud.test.js
├── persistence.test.js
├── transactions.test.js
├── middleware.test.js
├── reactive.test.js
├── pubsub.test.js
├── schema.test.js
├── jss.test.js
├── diff.test.js
├── sets.test.js
├── edge-cases.test.js
├── errors.test.js
├── memory.test.js
├── vector.test.js
├── vector-tx.test.js
├── graph.test.js
├── cascade.test.js
├── aggregation.test.js
├── secondary-index.test.js
├── coverage-gaps.test.js
└── final-coverage.test.js
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
Vector search end-to-end (UC-V1) - top-k cosine similarity, filter composition, dimension validation, score metadata, legacy call-form back-compat, persistence (snapshot v3 + WAL replay), drift detection.

### `vector-tx.test.js`
Vector transaction integration (UC-V4) - staged-write isolation (visible inside txn, invisible outside via `.near` opts.txnId override), nop pristine, fin atomic commit, pop undoes last vector write, crash recovery to pre-txn state.

### `graph.test.js`
Predicate proxy + edge collections (UC-G1) - one-hop predicate read returns outgoing targets, predicate filtering, full reactive-entity hydration, edge document write via `alice.works_at(target, attrs)`, reserved-name collision detection at schema load, .limit(k) bounded read, regression guard for collections without edges.

### `cascade.test.js`
Schema-scoped cancellation cascade (UC-X2, §10 non-negotiable) - cascadeOn-flagged collection rows deleted by scope id, knowledge collections (no flag) immune, multi-collection cascade in one call, idempotent re-runs, vector + graph index consistency through cascaded deletes, other-session txn isolation, byField escape hatch, no-op safety on unknown scopes and empty registry.

### `aggregation.test.js`
Aggregation primitives (UC-X3) - .count() with and without filter, .distinct(field) with and without filter, .groupBy().count() / .sum(field) / .having(filter), and filter operator coverage ($gte/$gt/$lte/$lt/$ne/$in/$exists).

### `secondary-index.test.js`
Secondary indexes (engine portion of UC-X1) - SortedIndex unit roundtrips, $indexes schema declaration, compound prefix matching, non-prefix scan fallback, mutation consistency on insert/update/delete, undeclared-field rejection, persistence across restart, bounded hydration when combined with .near.

### `coverage-gaps.test.js`
Additional test cases for uncovered code paths.

### `final-coverage.test.js`
Final coverage sweep for remaining gaps.
