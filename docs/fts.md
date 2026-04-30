# Full-Text Search

Bri's `.match()` chain method does case-insensitive substring matching on string-or-array fields, with optional top-k cap and a recency tiebreak. Combined with `.near()` via `.combine()`, it powers UC-V3's hybrid alias + embedding retrieval.

> **Status:** v1 — basic substring scan only, no stemming or stopwords. Spec §6.1 explicitly scopes the substring-only behavior to v1; §6.2 will add stemming, stop-word filtering, and a persistent FTS index. v1 stays inline-correct so the higher layers can build on a stable behavior contract.

---

## Quick start

```js
db.schema('memoryArtifact', {
  type:    { type: String, required: true },
  content: { type: String, required: true }
});

await db.add.memoryArtifact({ type: 'fact', content: 'API gateway design notes' });
await db.add.memoryArtifact({ type: 'fact', content: 'Notes on the API gateway tier' });

// Find docs whose `content` contains 'API gateway' (case-insensitive).
const hits = await db.get.memoryArtifactS.match({ content: 'API gateway' });

// Cap to top-k (default unbounded):
const top3 = await db.get.memoryArtifactS.match({ content: 'API gateway' }, 3);

// Compose with .where to prefilter:
const factsOnly = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .match({ content: 'API gateway' });
```

---

## API: `.match(stringFilter, k?)`

| Argument | Description |
|---|---|
| `stringFilter` | Object of shape `{fieldName: 'query'}`. Multi-field filters are accepted but treated as a logical OR — a doc matches if ANY field contains its query |
| `k` (optional) | Top-k cap on results |

Each result entity gets a non-enumerable `$matchHits` property:

```js
hit.$matchHits  // { field: 'content', value: 'API gateway' }
```

`$matchHits` records the **first** field that matched, not all matching fields, so the audit trail stays compact.

---

## Field-type behavior

| Field type | Match condition |
|---|---|
| String | `value.toLowerCase().includes(query.toLowerCase())` |
| Array of strings | At least one element passes the string check above |
| `null` / `undefined` | Never matches |
| Number / Boolean / Object | Never matches (non-string fields aren't candidates for substring FTS) |

---

## Sorting and recency tiebreak

`.match` produces a binary score: 1 if matched, 0 otherwise. Sort order:

1. **Score desc** — matches before non-matches (non-matches are dropped before sort).
2. **`updatedAt` desc** — newer docs rank above older ones on equal score (UC-X4's `recency_tiebreak` criterion).

The tiebreak uses `updatedAt`, not `createdAt`, so a re-edited doc surfaces as fresh. v2 may add custom sort keys via the schema; v1 keeps the policy simple and unconfigurable.

---

## Combining with `.near` via `.combine`

`.combine({alias, vector})` blends `.match` (alias score) and `.near` (cosine score) into a single ranked result. Both `.match` and `.near` MUST appear earlier in the chain — otherwise `.combine`'s `.toArray()` throws with a diagnostic.

```js
db.schema('kgEntity', {
  name:      { type: String, required: true },
  aliases:   { type: Array, required: false, items: String },
  embedding: { type: 'vector', dims: 1536, required: false }
});

const results = await db.get.kgEntityS
  .match({ aliases: 'API gateway' })
  .near(queryVector, 20)
  .combine({ alias: 0.4, vector: 0.6 });
```

### Scoring formula

```
$score = weights.alias * matchScore  +  weights.vector * cosine
```

- `matchScore` ∈ {0, 1}
- `cosine` ∈ [-1, 1] (typically [0, 1] for normalized embeddings)
- Missing components are treated as 0 — a doc with no embedding still ranks via alias alone (UC-V3 `null_embedding_eligible_via_alias`)
- Docs whose blended score is exactly 0 are dropped (no component contributed)

### Audit-trail metadata

Each result carries non-enumerable fields so callers can inspect the blend:

| Field | Source |
|---|---|
| `$score` | The blended composite |
| `$cosine` | The vector cosine (or `0` if the doc had no embedding) |
| `$matchHits` | `{field, value}` of the matched field (or `undefined` if alias didn't contribute) |

The `audit_trail_components_returned` UC-V3 acceptance test asserts each of these is present so re-rankers downstream of Bri (e.g., Ashlyn's promotion-gate scoring) can compute additional signals from the components rather than the blended score alone.

---

## How `.match` and `.combine` integrate with the rest of the system

```
db.get.{coll}S.where(...).match(...).near(...).combine(...)
                │            │          │           │
                │            │          │           └─ blends scores per weights
                │            │          └─ vector top-k via VectorIndex.searchFiltered
                │            │             (predicate = candidate-set membership)
                │            └─ substring scan over candidate hydrated docs;
                │               binary score + $matchHits attribution
                └─ QueryPlanner: index hit → bounded candidate set;
                   miss → full-collection scan (residual filter on doc body)
```

The candidate set is the same in all three branches — `.where` defines it, the chain tail (match / near / combine) consumes it. This is intentional: secondary-index prefilter keeps hydration bounded for both `.match` and `.combine` on indexed collections.

---

## Limitations (v1)

- **Substring containment only** — no tokenization, stemming, or stopword filtering. v2 deliverable per spec §6.2.
- **No fuzzy match** (Levenshtein, BK-tree, etc.) — call sites that need fuzzy retrieval should embed instead and use `.near`.
- **Inline scan, no persistent FTS index** — UC-X4's `fts_index_eventually_consistent` is trivially true in v1 because there's no index to lag.
- **Single-field scoring** — multi-field `.match({a: 'x', b: 'y'})` is OR-semantics with first-match attribution; v2 may add weighted per-field scoring.
- **`.combine` weights** are caller-supplied numbers — no normalization, no soft-max. Spec assumes the caller knows what they want.

---

## See also

- [`client/match-engine.js`](../src/client/match-engine.js) — execution helpers (`executeMatch` / `executeCombined`)
- [`client/query-builder.js`](../src/client/query-builder.js) — chain method declarations and dispatch
- [`tests/e2e/match.test.js`](../tests/e2e/match.test.js) — UC-X4 + UC-V3 acceptance suite
- [`docs/aggregation.md`](aggregation.md) — `.where` operator vocabulary that prefilters `.match`
- [`docs/vector.md`](vector.md) — `.near` vector search that `.combine` blends with
