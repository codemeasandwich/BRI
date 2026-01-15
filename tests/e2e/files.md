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

### `coverage-gaps.test.js`
Additional test cases for uncovered code paths.

### `final-coverage.test.js`
Final coverage sweep for remaining gaps.
