# Vector Search

Bri supports embedding-based similarity search as a first-class read primitive. Declare a vector field in a collection's schema and the engine maintains a per-collection vector index, queryable through the same `db.get` proxy you already use for attribute reads.

> **Status:** v1 slice — UC-V1 (`.where` + `.near` over a single vector field per collection). Backwards-compatible: existing collections without a registered schema behave exactly as before.

---

## Quick start

```js
import { createDB } from 'bri-db';

const db = await createDB({ storeConfig: { dataDir: './data' } });

// Declare a schema with a vector field. The 'vector' type takes a `dims` value
// that every embedding written to this collection must match.
db.schema('memoryArtifact', {
  type:      { type: String, required: true },
  content:   { type: String, required: false },
  embedding: { type: 'vector', dims: 1536, metric: 'cosine', required: false },
});

// Write an artifact (embedding generation is the caller's responsibility —
// the database stores whatever array of floats you give it).
const fact = await db.add.memoryArtifact({
  type: 'fact',
  content: 'Brian prefers terse responses',
  embedding: yourEmbedder('Brian prefers terse responses'),
});

// Search.
const results = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .near(yourEmbedder('how does Brian like answers?'), 5)
  .toArray();

// Each result is a reactive entity with a $cosine score attached.
for (const r of results) {
  console.log(r.$ID, r.$cosine, r.content);
}
```

---

## Schema declaration

A `'vector'` field requires `dims`. The `metric` defaults to `'cosine'` (the only metric supported in v1).

```js
embedding: { type: 'vector', dims: 1536, metric: 'cosine' }
```

**Validation rules** (returned as descriptive error strings from `validate()`):

- The value must be an array.
- The array length must equal `dims`.
- Every element must be a finite number (no `NaN`, `Infinity`, or non-numerics).

A schema may declare at most one vector field per collection. Declaring two raises an error at `db.schema()` time, not at query time.

---

## The chainable read API

`db.get.{collection}S` returns a chainable query builder when you access a chain method. Calling it with parens preserves the legacy group-fetch behavior.

| Method | Description |
|---|---|
| `.where(filter)` | Attribute filter. Object form does equality matching (`{type: 'fact'}`); function form runs as a predicate. |
| `.near(vector, k)` | Top-k cosine similarity over the collection's vector field. |
| `.limit(n)` | Cap result count. |
| `.toArray()` | Terminal — returns `Promise<Array<entity>>`. |
| `.first()` | Terminal — returns `Promise<entity \| null>`. |
| `await builder` | The builder is thenable; awaiting executes `.toArray()`. |

Composition: when both `.where` and `.near` are present, the filter is applied **during** vector search (not as a post-filter). This guarantees that if you ask for `k=5` facts and only 3 facts exist, you get those 3 facts — not 3 facts plus 2 ineligible non-fact neighbours.

---

## Result shape

Every result is the standard Bri reactive entity. Two non-enumerable metadata fields are attached after a vector search:

- `entity.$cosine` — cosine similarity (`-1` to `1`; `1` means identical direction)
- `entity.$score` — same as `$cosine` for v1; reserved for weighted blends in later slices

These fields do not appear in `Object.keys()` and are excluded from `toObject()`. Read them directly:

```js
const [hit] = await db.get.memoryArtifactS.near(query, 1);
console.log(hit.$cosine);     // 0.8731
hit.content = 'edited';
await hit.save();              // standard reactive entity behavior preserved
```

---

## Errors

| Trigger | Behavior |
|---|---|
| Inserting a vector whose length doesn't match `dims` | Validation middleware throws with a descriptive message |
| Inserting a vector containing `NaN` or `Infinity` | Validation middleware throws with the offending index |
| Calling `.near` on a collection with no registered vector field | Throws — message names the collection and explains how to register a schema |
| Query vector dims mismatch | Throws on `.toArray()` resolution; message reports expected vs got |

---

## Backwards compatibility

Collections without a registered schema get the exact same behavior they had before vectors existed:

```js
// No db.schema('user', ...) anywhere — works exactly as before.
const all = await db.get.userS();
const alice = await db.get.user('USER_alice');
```

The legacy call form `db.get.userS(...)` continues to work even on collections with vector fields registered — it bypasses the builder entirely.

---

## Persistence

Vector indices are persisted as part of the standard snapshot format (snapshot version 3). On boot, the index is restored before the user calls `db.schema()`; the schema declaration validates against the persisted shape and reuses the loaded index. WAL records written between snapshots are replayed on top of the restored index, so a crash mid-write loses no data.

### What's persisted

For each collection that declared a vector field, the snapshot contains:

- A binary-packed serialization of the index (cosine + Float32Array slots, base64-wrapped inside the snapshot JSON).
- The schema metadata: field name, dimensionality, metric.

### Drift detection

If the schema declared on a second boot does not match what's persisted, `db.schema()` throws with a diagnostic message:

| Drift | Behavior |
|---|---|
| `dims` mismatch | Throws — refuses to load a 1536-dim index against a `dims: 768` declaration |
| `metric` mismatch | Throws — same rationale |
| Vector field renamed | Throws — auto-migration not provided; rename keeps the old persisted index targeting the old field |

Resolution: revert the schema change, or delete the data directory and rebuild the index from a fresh insert pass.

### Encryption parity

When `BRI_ENCRYPTION_KEY` is set, the snapshot is AES-256-GCM-encrypted as a whole. Vector data inherits this encryption automatically — there is no plaintext side-channel for embeddings.

### Snapshot version migration

| Snapshot version | Reader | Writer |
|---|---|---|
| v1 / v2 (no vectors) | Loads cleanly; vector path is skipped | Continues to write v2 if no vector schema is registered |
| v3 (with vectors) | Loads vector indices and schemas | Written automatically when any vector schema exists |

A v2 snapshot does not need migration; the next snapshot that has a vector schema is written as v3.

---

## Limitations (v1)

- One vector field per collection.
- Brute-force linear scan; latency is O(N) in collection size. At v1 target scales (≤10k vectors) this is well under the spec's correctness budget. v2 will add an HNSW-style index behind the same interface.
- No worker-thread offload — search runs on the main thread. Acceptable at v1 scale; v2 moves the index behind a Worker.

---

## Transactions (UC-V4)

Vector writes inside an open transaction are buffered per-txn and flushed atomically on `db.fin()`. Outside-txn searches never see staged writes; inside-txn searches see them immediately.

```js
db.rec();
const fact = await db.add.memoryArtifact({ type: 'fact', embedding });

// Inside the txn — sees the staged write.
const inside = await db.get.memoryArtifactS.near(embedding, 1);  // contains fact

// Side-door check from "outside": opt out via .near's opts.
const outside = await db.get.memoryArtifactS.near(embedding, 1, { txnId: null });  // empty

await db.fin();   // staged write becomes committed; both views agree.
```

### Lifecycle

| Action | Vector-index effect |
|---|---|
| `db.rec()` | No-op for vector layer |
| `db.add` / `db.set` / `db.del` inside a txn | Op queued in the index's pending buffer for that txnId |
| `db.fin(txnId)` | All pending ops flushed to the committed index in order |
| `db.nop(txnId)` | Pending bucket discarded — committed index is bit-identical to pre-`rec()` |
| `db.pop(txnId)` | Most recent pending op for the popped action's `$ID` is removed (note: a single `db.add` records SET + SADD actions, so a full add-undo requires two `pop()` calls) |
| Crash mid-txn | Pending lives only in memory; on reboot the snapshot+WAL replay restore the committed-only state automatically — no special recovery for vectors needed |

### Search semantics

`.near(query, k)` consults the active transaction by default. Override per-query:

| `opts.txnId` | Behavior |
|---|---|
| omitted | Use the active txn (default) — sees pending + committed |
| `null` | Force committed-only — useful for verifying isolation |
| `'<txnId>'` | Query a specific transaction's view (must be open) |

The committed buffer is never modified during a transaction, so a long-running txn doesn't degrade outside-txn search latency.

---

## Combining `.where` with `.near`

For the lowest latency, declare a secondary index on the field your `.where` filters by. When the index covers the filter, the vector search runs against a bounded candidate set and only the final `k` hits are hydrated.

```js
db.schema('memoryArtifact', {
  type:      { type: String, required: true },
  embedding: { type: 'vector', dims: 1536 },
  $indexes:  [['type']],
});

// Hydration is O(k), not O(collection).
const facts = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .near(query, 5);
```

See [docs/indexes.md](indexes.md) for the full secondary-index surface.

---

## See also

- [`engine/vector-index.js`](../engine/vector-index.js) — index implementation
- [`engine/schema-registry.js`](../engine/schema-registry.js) — schema → index wiring
- [`client/query-builder.js`](../client/query-builder.js) — chainable read API
- [`tests/e2e/vector.test.js`](../tests/e2e/vector.test.js) — UC-V1 acceptance suite
- [`docs/indexes.md`](indexes.md) — secondary indexes for bounded `.where`
