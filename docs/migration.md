# Migration — adopting vector + graph in an existing Bri project

This page is the migration path for projects already using Bri without
schema declarations. Existing collections continue to work unchanged
with the existing API. Vector + graph features simply require schema.

## What still works exactly as before

- `db.add.foo(...)` / `db.get.foo(...)` / `db.set.foo(...)` /
  `db.del.foo(...)` / `db.sub.foo(cb)` — the proxy traps for
  collections without a schema run the same code path as v0.
- `db.get.fooS()` (call form) — the legacy callable group form is
  unchanged. Chain syntax (`db.get.fooS.where(...)`) is opt-in by NOT
  passing `()`.
- `entity.and.{ref}` — single-hop ref population still works; vector +
  graph add `entity.{predicate}` and `entity.expand` on top, they do
  not replace `.and`.
- `db.rec()` / `db.fin()` / `db.nop()` / `db.pop()` — transactions
  unchanged; tags via `{sessionId}` are optional.
- Snapshots + WAL replay — old format snapshots load and rebuild
  vector + secondary indexes from documents on first boot. New
  snapshots are v3 format with embedded index buffers.
- `BRI_ENCRYPTION_KEY` — at-rest encryption covers the new index state
  (snapshot AES-256-GCM is the same gate).

## Step 1 — declare schemas for the collections you want to upgrade

Vector + graph features are schema-driven. Declare schemas for
collections that need:
- vector search (`'vector'` field)
- ref validation + existence checks (`'ref'` field)
- secondary indexes (`$indexes`)
- supersession filtering (`$supersession`)
- predicate-proxy edges (`$edge`)
- cancellation cascade scope (`cascadeOn` field flag)

```js
db.schema('memoryArtifact', {
  type: { type: String, required: true },
  embedding: { type: 'vector', dims: 1536 },
  source_session_id: { type: String, cascadeOn: 'session' },
  $supersession: 'superseded_by_id',
  superseded_by_id: { type: 'ref', to: 'memoryArtifact', required: false }
});
```

Run this once at startup. Existing data is untouched until you mutate
it; new mutations validate against the schema.

## Step 2 — opt-in to chain syntax where it matters

```js
// before: legacy call form
const facts = await db.get.memoryArtifactS({ type: 'fact' });

// after: chain form unlocks .near / .match / .combine / .confidence /
// .history / .withProvenance / .hydrate / .touching / .limit / .count
// / .distinct / .groupBy / .first
const top5 = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .near(queryVec, 5)
  .confidence(0.7);
```

Both forms coexist. Chain form requires the schema to declare the
relevant fields (vector for `.near`, `$confidence` for `.confidence`,
etc.).

## Step 3 — adopt predicate proxy for graph edges

Define an edge collection schema with `$edge` and the predicate-proxy
on subject entities lights up:

```js
db.schema('kgEntity', { name: { type: String, required: true } });
db.schema('kgTriple', {
  subject_id: { type: 'ref', to: 'kgEntity', required: true },
  predicate:  { type: String, required: true },
  object_id_or_literal: { type: 'ref|string', to: 'kgEntity', required: true },
  $edge: { from: 'kgEntity', to: 'kgEntity', predicate: 'predicate',
           predicates: ['works_at', 'knows'] }
});

const alice = await db.add.kgEntity({ name: 'Alice' });
const acme  = await db.add.kgEntity({ name: 'Acme' });
await alice.works_at(acme);                         // predicate write
const employers = await alice.works_at;             // predicate read
const employees = await acme.inverse.works_at;      // inverse read
```

## Step 4 — wire cascade scopes

If you use Bri as a memory tier scoped per session/tenant/etc.:

```js
db.schema('memoryArtifact', {
  // ...
  source_session_id: { type: String, cascadeOn: 'session' }
});

await db.cascade.session('SESS_abc'); // delete all artifacts tagged SESS_abc
```

Knowledge collections (no `cascadeOn` flag on any field) are immune by
construction — the two-store invariant.

## Errors changed shape (validator → throws)

`utils/schema/index.js` validate() previously returned `string|null`;
v1 throws `BriValidationError` instead. If your code did:

```js
// before
const err = validate(schema, doc);
if (err) reject(err);
```

Switch to:

```js
// after
try { validate(schema, doc); }
catch (e) { /* e instanceof BriValidationError; e.code carries the codename */ }
```

Most call sites are inside Bri middleware and have already been updated
in v1. External call sites (custom validators) need the catch.

## Worker thread is opt-in

Spec §3.2 introduces a Worker Thread for vector ops; v1 keeps the
default in-process for compatibility. Opt in via:

```js
import { createWorkerVectorIndex } from 'bri-db/workers/index-worker-host.js';
const idx = await createWorkerVectorIndex({ collection: 'foo', dims: 1536 });
```

Or set `BRI_VECTOR_WORKER=true` in test runs that need the offload
(scale tests, bulk-insert non-blocking acceptance).

## Reserved names — schema review

Before deploying, audit your schemas for predicate names or ref-field
names that collide with the reserved list (see `proxy-conventions.md`).
The schema loader throws `RESERVED_NAME_COLLISION` at startup if
anything collides — fail fast in dev rather than at the first user
query.
