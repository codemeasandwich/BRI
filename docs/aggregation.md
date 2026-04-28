# Aggregation

Bri provides standard aggregation primitives on the chainable query builder: `.count()`, `.distinct(field)`, `.groupBy(field).count()`, `.groupBy(field).sum(field)`, with optional `.having(filter)` for post-aggregation filtering.

> **Status:** v1 — covers the spec's UC-X3 acceptance criteria. `.min`, `.max`, `.avg` are not yet implemented; same single-source-of-truth filter compiler powers `.where`, `.having`, and the planner residuals.

---

## Quick start

```js
// Count
const total = await db.get.memoryArtifactS.count();
const factsOnly = await db.get.memoryArtifactS.where({ type: 'fact' }).count();

// Distinct
const sessions = await db.get.memoryArtifactS
  .where({ usage_count: { $gte: 3 } })
  .distinct('source_session_id');
// → ['SESS_a', 'SESS_b', ...]

// Group by + count
const byType = await db.get.memoryArtifactS.groupBy('type').count();
// → [{ type: 'fact', count: 47 }, { type: 'preference', count: 12 }, ...]

// Group by + sum + having
const popular = await db.get.lexicalEdgeS
  .groupBy('node_a')
  .sum('co_occurrence_count')
  .having({ sum: { $gte: 10 } });
// → [{ node_a: 'LEEN_abc', sum: 47 }, ...]
```

---

## Terminals

| Terminal | Returns |
|---|---|
| `.count()` | `Promise<number>` — count of docs after `.where` filter |
| `.distinct(field)` | `Promise<Array>` — distinct field values, in insertion order |
| `.groupBy(field).count()` | `GroupedQueryBuilder` (thenable) — `[{<field>: value, count: N}, ...]` |
| `.groupBy(field).sum(otherField)` | `GroupedQueryBuilder` — `[{<field>: value, sum: N}, ...]` |
| `.having(filter)` after `.count`/`.sum` | Same shape, post-filtered |

`.count` and `.distinct` do not currently compose with `.near` — vector top-k semantics for aggregation aren't well-defined as a primitive yet. The builder throws if you try.

---

## Filter operators

The same compiler powers `.where`, `.having`, and the query planner's residuals. Supported operators (spec §2.2):

| Operator | Meaning |
|---|---|
| (no operator) | equality |
| `$ne` | not equal |
| `$gt` / `$gte` | greater than (or equal) |
| `$lt` / `$lte` | less than (or equal) |
| `$in` | value is in the supplied array |
| `$exists` | `true` → not null/undefined; `false` → is null/undefined |

Multiple operators in one clause AND together: `{score: {$gt: 5, $lte: 15}}` matches `5 < score <= 15`.

```js
// Range filter
const recent = await db.get.memoryArtifactS
  .where({ created_at: { $gte: lastWeek } })
  .count();

// Set membership
const targeted = await db.get.memoryArtifactS
  .where({ type: { $in: ['fact', 'preference'] } });

// Existence
const tagged = await db.get.memoryArtifactS
  .where({ tag: { $exists: true } });
```

---

## How `.having` composes

After `.groupBy(field).count()` or `.groupBy(field).sum(other)`, the rows have shape `{ <groupField>: value, count|sum: N }`. `.having(filter)` filters those rows using the standard compiler:

```js
.groupBy('node_a').sum('count').having({ sum: { $gte: 10 } })
//        └──┬──┘   └─aggregate┘   └────filter on aggregated field────┘
```

Both the group field and the aggregated field are addressable in `having`:

```js
.groupBy('type').count().having({ type: { $ne: 'meta' }, count: { $gte: 3 } })
```

---

## Index integration

`.count`, `.distinct`, and `.groupBy` all run through the same `.where` path that the QueryPlanner consults. If a `.where` filter matches a declared `$indexes` prefix (and contains no operator clauses on covered fields), only the candidate set is hydrated — aggregation cost is bounded by selectivity.

Operator-clause fields (`{$gte: 5}`) currently fall back to the residual-filter path even if they appear in `$indexes`. v2 will add range support to `SortedIndex`.

---

## Limitations (v1)

- No `.min`, `.max`, `.avg` aggregations yet.
- `.count` / `.distinct` don't compose with `.near` — throws if combined.
- `.having` doesn't accept function filters (object-form only).
- Multi-key `.groupBy(['a', 'b'])` not supported — single field only.
- Range queries on indexed fields fall back to scan.

---

## See also

- [`engine/filter-compiler.js`](../engine/filter-compiler.js) — shared `compileFilter` with operator support
- [`client/query-builder.js`](../client/query-builder.js) — `QueryBuilder.count/distinct/groupBy` and `GroupedQueryBuilder`
- [`tests/e2e/aggregation.test.js`](../tests/e2e/aggregation.test.js) — UC-X3 acceptance suite
