# Illustrative §F scenarios (non-executable)

This page collects **documentation-only** walkthroughs inspired by specification §F (memory-tier and knowledge-tier flows).

**Important:** fenced blocks below are **illustrations**, not a second test harness. They omit imports, bootstrap paths, and fixture loaders. Authoritative behaviour is enforced by **`tests/e2e/`** (and shared helpers under **`tests/fixtures/`**). Do **not** expect to paste an entire section into Node and run it unchanged.

---

## Scenario 1 — Memory artifact lifecycle (vector + supersession + cascade)

**Ideas shown:** schema with vector + confidence + **`$supersession`** + **`cascadeOn`**; **`openLocalDatabase`** (or equivalently **`bri.connect`** then await backing if you defer); recalls with **`.where` + `.near`**; **`.confidence` threshold** reads; superseding hides old rows unless **`.history`**; **`db.cascade.session(sessionId)`** tears down staged memory.

Representative fragments (glue and **`applyFixtureSchemas`/`makeEmbedding`** are omitted on purpose):

```javascript
const db = await openLocalDatabase({
  storeConfig: { dataDir: tmpDir, maxMemoryMB: 64 }
});
// … register schemas via applyFixtureSchemas / db.schema ...

const a = await db.add.memoryArtifact({
  type: 'fact',
  content: 'cats sleep 16h/day',
  embedding: makeEmbedding(1, DIMS),
  confidence: 0.6,
  source_session_id: 'S1'
});

const hits = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .near(nearVectorOf(1, DIMS), 5);

const trustworthy = await db.get.memoryArtifactS.confidence(0.8).toArray();

const c = await db.add.memoryArtifact({
  type: 'fact',
  content: 'cats sleep 13-16h/day',
  embedding: makeEmbedding(3, DIMS),
  confidence: 0.95,
  source_session_id: 'S1'
});
a.superseded_by_id = c.$ID;
await a.save();

const visible = await db.get.memoryArtifactS.toArray();
const all = await db.get.memoryArtifactS.history.toArray();

await db.cascade.session('S1');
```

For API detail see [vector.md](vector.md), [transactions.md](transactions.md), and [cascade.md](cascade.md).

---

## Scenario 2 — Knowledge-graph triples (predicates + expand)

**Ideas shown:** entity and edge **`$edge`** schemas; loading seed entities/triples (fixtures); **predicate proxies** (**`alice.works_at`**); **inverse** edges; **`knows.confidence`**; supersession chain on **`kgTriple`**; **`expand`** for bounded multi-hop traversal.

Fragments only — **`loadKGFixture`** and schema setup are illustrative:

```javascript
const db = await openLocalDatabase({
  storeConfig: { dataDir: tmpDir, maxMemoryMB: 64 }
});
// … applyFixtureSchemas(db); …
const { entities, idsByName } = await loadKGFixture(db);
const byName = Object.fromEntries(entities.map(e => [e.name, e]));

const employers = await byName['Alice'].works_at;
const employees = await byName['Acme'].inverse.works_at;

const trustyAcquaintances = await byName['Alice'].knows.confidence(0.75);

const aliceId = idsByName['Alice'];
const oldKnows = (
  await db.get.kgTripleS({
    subject_id: aliceId,
    predicate: 'knows',
    object_id_or_literal: idsByName['Carol']
  })
)[0];
const newKnows = await db.add.kgTriple({
  subject_id: aliceId,
  predicate: 'knows',
  object_id_or_literal: idsByName['Carol'],
  confidence: 0.9,
  source_session_id: 'fixture',
  provenance_turn_ids: ['turn-2']
});
oldKnows.superseded_by_id = newKnows.$ID;
await oldKnows.save();

const chain = await newKnows.chain.supersedes_id;

const fan = await byName['Alice'].expand({ via: 'kgTriple', hops: 1 });
```

For graph predicates and **`expand`** semantics see [graph.md](graph.md).
