# Cancellation Cascade

Bri implements a schema-scoped bulk-delete primitive — `db.cascade.{scope}(id)` — that deletes rows from every collection whose schema declared an opt-in `cascadeOn` field for that scope. The non-cascade-flagged collections are invariant under cascade: knowledge-tier data survives memory-tier cancellations.

> **Status:** This is a §10 non-negotiable per the V8 spec. The two-store invariant (memory tier cleans up, knowledge tier persists) is mandatory; tests gate it explicitly.

---

## Quick start

```js
db.schema('memoryArtifact', {
  type:              { type: String, required: true },
  content:           { type: String, required: false },
  source_session_id: { type: String, required: false, cascadeOn: 'session' }
});

// Knowledge tier deliberately omits cascadeOn — invisible to cascade.
db.schema('kgEntity', { name: { type: String, required: true } });

// ... after writes ...
const result = await db.cascade.session('SESS_abc');
console.log(result);
// → { deleted: 47, byCollection: { memoryArtifact: 47 } }
```

---

## Scope vocabulary

A scope is just a string. The schema declares which fields opt into which scope:

```js
source_session_id: { type: String, cascadeOn: 'session' }
source_tenant_id:  { type: String, cascadeOn: 'tenant' }
project_id:        { type: String, cascadeOn: 'project' }
```

Any string works. `db.cascade.{scope}(id)` resolves at access time — there's no enumeration list to maintain. New scopes added by schema authors require zero engine changes.

The reserved-name list (§0.4) does not apply to scope names; the proxy returns the scope-runner without method-name conflict.

---

## What gets deleted

For each call, the registry walks every collection that has any field with the matching `cascadeOn`. Within those collections, every doc whose field equals the supplied id is deleted via `db.del.{collection}($ID)` — meaning the standard middleware fires:

- Schema validation (no-op on delete)
- Vector-index removal (if collection has a vector field)
- Graph-index edge removal (if collection has `$edge`)
- Secondary-index entry removal (if collection has `$indexes`)

A collection without `cascadeOn` for that scope is **invisible** to the routine — that's the §10 invariant. `db.cascade.session('X')` cannot touch a knowledge-tier collection because the engine never enumerates collections that didn't opt in.

---

## API

### `db.cascade.{scope}(id, opts?)`

| Option | Effect |
|---|---|
| `atomic: true` | Wrap the cascade in an internal `rec()`/`fin()`. A failure mid-cascade rolls back via `nop()`. Default `false` so each delete commits independently |
| `txnId: null` | Bypass the active transaction — operate on committed state only. Useful when you want cascade to ignore your in-flight session writes |
| `txnId: '<id>'` | Run the cascade inside a specific (already-open) transaction |

Returns `{ deleted, byCollection }`:
- `deleted` — total count of docs removed across all collections
- `byCollection` — `{ collection: count }` breakdown

### `db.cascade.byField({ collections, filter, opts? })`

Explicit form for when the schema doesn't have `cascadeOn` flags or the caller wants to delete by some other criterion. Filter is the standard Bri object filter (equality matching).

```js
await db.cascade.byField({
  collections: ['memoryArtifact'],
  filter: { tag_id: 'T1' }
});
```

---

## Transaction interaction

Cascade does NOT manage transactions. Compose at the call site:

```js
// Idiomatic session cancellation: drop in-flight, then bulk-delete committed.
db.rec();
// ... user does some session writes that they end up wanting to cancel ...
await db.nop();                          // drops staged writes (V4)
await db.cascade.session('SESS_X');      // bulk-deletes committed memory artifacts
```

This pattern combines the V4 `nop` (which drops vector pending buckets and txn shadow state) with the cascade routine. Together they implement a clean "cancel session" that leaves no trace in committed state, the vector index, the graph index, or the WAL.

For atomic-mid-cascade safety, opt in:

```js
await db.cascade.session('SESS_X', { atomic: true });
```

This wraps the entire cascade in a single transaction — if any delete fails, the whole cascade rolls back.

---

## Idempotence

Re-running cascade on the same scope id is a no-op — the second call finds no matching docs and returns `{ deleted: 0 }`. This makes cascade safe to retry on transient failure without double-effects.

---

## Limitations (v1)

- **No cascade across edge collections via `$edge`.** Edges referring to a deleted entity remain. The recommended pattern is to mirror the cascade flag onto the edge collection (`source_session_id` on each edge doc) so cascading by session removes both nodes and edges.
- **No cross-collection atomic per-doc semantics.** Each delete commits independently unless `{ atomic: true }`.
- **No cascade hooks** for downstream notifications. v2 may add `before:cascade` / `after:cascade` hooks parallel to the existing middleware events.

---

## See also

- [`engine/cascade.js`](../src/engine/cascade.js) — `createCascade` / `cascadeScope` / `cascadeByField`
- [`engine/schema-registry.js`](../src/engine/schema-registry.js) — `cascadeEntriesFor(scope)`
- [`tests/e2e/cascade.test.js`](../tests/e2e/cascade.test.js) — UC-X2 acceptance suite
- [`docs/vector.md`](vector.md) — V4 transaction lifecycle that composes with cascade
