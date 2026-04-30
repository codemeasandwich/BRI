# Secondary Indexes

Bri supports schema-declared compound indexes that bound `.where` lookups before they hit document bodies. When a query's filter matches a declared index (or any prefix of one), the engine narrows the candidate set via the index and hydrates only the candidates — not the whole collection.

> **Status:** v1 — planner optimizes equality-shaped filters into secondary indexes persisted on snapshot. Operators such as **`$gte` / `$lte` / `$in` / `$exists`** execute through the [`filter-compiler`](../engine/filter-compiler.js) as residual predicates whenever the secondary index stops matching (operator clauses intentionally skip compound-index acceleration today). Deferred work: richer index intersection + operator-aware index merges.

---

## Quick start

```js
db.schema('memoryArtifact', {
  type:    { type: String, required: true },
  session: { type: String, required: true },
  $indexes: [
    ['type'],                  // single-field
    ['session', 'type'],       // compound — supports prefix lookup on session
  ],
});

await db.add.memoryArtifact({ type: 'fact', session: 'S1' });
await db.add.memoryArtifact({ type: 'fact', session: 'S2' });
await db.add.memoryArtifact({ type: 'pref', session: 'S1' });

// Hits the [type] index.
const facts = await db.get.memoryArtifactS.where({ type: 'fact' });
// Hits the [session, type] index — full compound match.
const factsInS1 = await db.get.memoryArtifactS.where({ session: 'S1', type: 'fact' });
// Hits the [session, type] index — prefix match on session alone.
const allInS1 = await db.get.memoryArtifactS.where({ session: 'S1' });
```

---

## Declaring indexes

The `$indexes` schema option is an array of arrays. Each inner array names one or more fields, in priority order, forming a compound index.

```js
$indexes: [
  ['fieldA'],                  // single-field index
  ['fieldA', 'fieldB'],        // compound index, prefix-usable
  ['session_id'],              // standalone single-field over a session column
]
```

### Validation rules

The schema loader validates `$indexes` at startup, not query time:

- Every field referenced must be declared on the same collection. Otherwise `db.schema()` throws with the offending field name and the list of available fields.
- Each entry must be a non-empty array of strings. Strings outside an array, or empty arrays, throw with a "malformed $indexes entry" message.

---

## How the planner picks an index

When you call `.where(filter)`, the engine consults the QueryPlanner. For a filter like `{a: 1, b: 2}`:

| Declared indexes | Picked | Why |
|---|---|---|
| `[['a']]`, `[['b']]` | `[a]` | First-field equality match |
| `[['a', 'b']]` | `[a, b]` | Full compound match — strongest selectivity |
| `[['a', 'b']]`, `[['a']]` | `[a, b]` | Both cover; longer prefix wins |
| `[['b']]` (filter is `{a:1}`) | none | `[b]` doesn't cover the filter prefix |

When no index covers the filter prefix, the planner falls back to a full-collection scan with the filter as a JS predicate. This keeps collections without `$indexes` working unchanged.

---

## Combining `.where` with `.near` (vector search)

The strongest selectivity comes from combining a `.where` (which the planner can satisfy via index) with a `.near` (which runs through the vector index). The behavior:

1. `.where` filter is fully covered by an index → the candidate set bounds the vector search predicate. Hydration is **O(k)**: only the final hits are read from storage.
2. `.where` filter is partially covered (residual fields remain) → the candidate set still narrows via the index, but the residual fields run as a JS predicate against hydrated docs. Hydration is **O(candidates)**: only docs the index returned are read.
3. `.where` filter is not covered → fall back to whole-collection hydration with the filter as residual. Hydration is **O(collection)**.

The first two paths are what UC-X1 calls "single round-trip" — no extra read pass beyond the candidate set.

---

## Mutation consistency

The engine keeps secondary indexes in sync on every write:

- **Insert (`db.add`)**: extracts the indexed field values from the new document, inserts the compound key into each declared index.
- **Update (`db.set`)**: pre-fetches the old document body so the OLD compound key can be removed; inserts the NEW key. Cost: one extra read per write to a collection with secondary indexes.
- **Delete (`db.del`)**: pre-fetches the doc body so the index can clean up its entries.

These updates happen inside the same middleware that handles vector indexing, so a write that satisfies validation always leaves both the document store and the indexes in a consistent state.

---

## Persistence

Secondary indexes are persisted as part of snapshot v3 — the same format that carries vector indices. On boot, the registry loads the persisted manager state before the first `db.schema()` call, and re-declarations that match the persisted spec reuse the loaded state.

There is no drift detection on `$indexes` today: re-declaring with a different spec simply adds the new spec alongside the loaded one. The next snapshot then carries both. To rebuild from scratch, delete the data directory or call `db._store.createSnapshot()` after manually clearing the manager.

---

## Limitations (v1)

- Equality filters only (`{field: value}`). Range operators (`$gte`, `$lt`, `$ne`) fall back to scan.
- Single best-fit index per query. Multi-index intersection is not implemented.
- Prefix matching only — a `[a, b, c]` index won't satisfy a filter on `b` alone.
- No drift detection on `$indexes` — schema changes that drop an index leave the persisted state in place until the next manual rebuild.

---

## See also

- [`engine/secondary-index.js`](../engine/secondary-index.js) — `SortedIndex` and `SecondaryIndexManager`
- [`engine/query-planner.js`](../engine/query-planner.js) — `QueryPlanner.planWhere`
- [`engine/vector-middleware.js`](../engine/vector-middleware.js) — write-time index sync
- [`tests/e2e/secondary-index.test.js`](../tests/e2e/secondary-index.test.js) — declaration, persistence, bounded hydration
- [`docs/vector.md`](vector.md) — vector capability that benefits from `$indexes`
