# Knowledge Graph

Bri models knowledge graphs with **edge collections** — collections whose schema declares a `$edge` block, naming the predicate field, the from/to constraints, and a registered predicate vocabulary.

Once declared, predicates surface as proxy methods on subject entities:

```js
await alice.works_at(acme, { confidence: 0.9 });   // write
const employers = await alice.works_at;            // read targets
```

> **Status:** v1 — UC-G1 (one-hop predicate read + write, inverse reads, `.related` over all predicates, `.$` for edge documents). Multi-hop chains, supersession defaults, confidence/provenance filters, and PPR are scoped for later slices.

---

## Quick start

```js
import { createDB } from 'bri-db';

const db = await createDB({ storeConfig: { dataDir: './data' } });

// 1. Declare the node collection.
db.schema('kgEntity', {
  name: { type: String, required: true }
});

// 2. Declare the edge collection — fields + $edge block.
//    The two ref fields (in declaration order) become the from/to fields
//    on each edge document. $edge.from / $edge.to are the COLLECTION
//    constraints (which collection's entities are valid endpoints).
db.schema('kgTriple', {
  subject_id:           { type: 'ref', to: 'kgEntity', required: true },
  predicate:            { type: String, required: true },
  object_id_or_literal: { type: 'ref', to: 'kgEntity', required: true },
  confidence:           { type: Number, required: false },
  $edge: {
    from:       'kgEntity',
    to:         'kgEntity',
    predicate:  'predicate',          // field name carrying the predicate value
    predicates: ['works_at', 'knows', 'authored']
  }
});

const alice = await db.add.kgEntity({ name: 'Alice' });
const acme = await db.add.kgEntity({ name: 'Acme' });

// Predicate write — invokes the predicate as a function on the subject.
await alice.works_at(acme, { confidence: 0.9 });

// Predicate read — accesses the predicate as a property; awaits to a list
// of fully-hydrated target entities.
const employers = await alice.works_at;
console.log(employers.map(e => e.name));   // ['Acme']
```

---

## The `$edge` schema block

| Key | Meaning |
|---|---|
| `from` | Collection-name constraint — which collection's entities are valid subjects |
| `to` | Collection-name constraint — which collection's entities are valid objects (`'a | b'` for polymorphic; v1 honors only single-collection refs) |
| `predicate` | Name of the field on the edge document carrying the predicate value (e.g. `'predicate'` or `'rel'`) |
| `predicates` | Array of registered predicate names (`['works_at', 'knows']`) — these become proxy methods on subject entities; `'*'` opens the predicate space (registered predicates required for v1 proxy resolution) |
| `symmetric` | Reserved (v1 doesn't enforce symmetry) |
| `unique` | Reserved (v1 doesn't enforce uniqueness) |

**Field-name derivation:** `$edge.from` and `$edge.to` are constraints on collection identity, not field names. The actual field names on the edge document are derived from the schema's `'ref'`-typed fields in declaration order — first ref is the from-field, second ref is the to-field.

**Reserved predicate names (§0.4):** the following names are reserved by the proxy surface and CANNOT be used as predicate names. Schema declaration throws if a predicate name collides with this list:

```
$  history  asOf  chain  expand  inverse  related  confidence  withProvenance
near  match  where  combine  limit  count  groupBy  distinct  having
touching  hydrate  toArray  first  save  toObject  toJSON  toJSS  and
```

This list is FROZEN — adding to it is a breaking change requiring a major version bump. Pick predicate names that don't collide; renaming a deployed predicate is a data-migration concern.

---

## Predicate access semantics

When you access `alice.works_at`:

1. The reactive proxy detects the access isn't a built-in (toJSON/save/and/etc.).
2. It looks up `alice`'s collection from the `$ID` prefix and consults the registry.
3. If `'works_at'` is a registered predicate where `alice`'s collection is a valid `from` endpoint, a **PredicateAccessor** is returned.
4. The PredicateAccessor is both callable (write) and thenable (read).

| Form | Effect |
|---|---|
| `await alice.works_at` | Read — returns array of target entities |
| `alice.works_at(target, attrs)` | Write — inserts an edge document and returns it |
| `alice.works_at.limit(k)` then await | Read with top-k cap |
| `await alice.works_at.$` | Read — returns the edge documents themselves (with attributes like confidence, source_session_id, etc.) |
| `await acme.inverse.works_at` | Inverse read — returns subjects whose edge points to acme |
| `await acme.inverse.works_at.$` | Inverse edge documents |
| `await alice.related` | Flat list of every outgoing target across all registered predicates |
| `await alice.related.$` | All outgoing edge documents across predicates |

If `'works_at'` isn't a registered predicate, property access falls through to the existing reactive-proxy behavior — field lookup, then undefined.

**`.inverse`** is a Proxy on the entity. Property access on it (the predicate name) consults the registry's inverse routing — set up at schema-declare time by walking each `$edge` block and recording the `to` collection alongside the `from` collection. Polymorphic `to` constraints (`'kgEntity | string'`) split on `|`; the literal `string` pseudo-collection is skipped (no entity to anchor inverse access on).

**`.related`** consults the per-subject predicate map and unions every outgoing predicate. v1 hydrates each edge collection separately, so two predicates that map to different edge collections are still flattened into one result array.

**`.$`** is a thenable property on every PredicateAccessor (and on `.inverse.{predicate}` / `.related`) that resolves to the edge documents instead of the hydrated endpoints. Useful when the consumer needs to read edge attributes (confidence, source_session_id, supersession state, etc.) without a separate fetch.

---

## How writes flow

```
alice.works_at(acme, { confidence: 0.9 })
   → predicate-proxy builds the edge doc:
       { subject_id: alice.$ID, predicate: 'works_at',
         object_id_or_literal: acme.$ID, confidence: 0.9 }
   → routes through db.add.kgTriple(doc) so the standard middleware fires:
       - schema validation against kgTriple's field declarations
       - vector-index sync (no-op here; kgTriple has no vector field)
       - secondary-index sync (no-op unless kgTriple declared $indexes)
       - graph-index sync (insertEdge keyed off the $edge spec)
   → returns the new edge entity (full reactive entity — has .save, etc.)
```

This means edge writes are subject to the same validation, transaction, and index-sync guarantees as any other write. A write inside a `db.rec()` transaction stays in the txn shadow state until `db.fin()`.

## How reads flow

```
await alice.works_at
   → predicate-proxy looks up edges via the GraphIndex:
       graphIndex.outgoing(alice.$ID, 'kgTriple', 'works_at')
   → returns edge $IDs in O(degree of alice)
   → hydrates each edge document to read its `to` field
   → hydrates each target entity by $ID
   → returns array of target entities
```

The GraphIndex maintains forward + inverse adjacency keyed by `(node, predicate)`, so a predicate read with N targets costs O(N) hydration regardless of total edge count.

---

## Multi-hop expand (UC-G6)

`entity.expand({...})` walks outward through an edge collection up to a hop budget, collecting reachable nodes, edges, and paths from the seed.

```js
const reach = await alice.expand({
  via:        'kgTriple',         // edge collection (required)
  hops:       2,                  // hop budget (default 1)
  budget:     { results: 100, ms: 25 },
  predicates: ['works_at', 'authored'],   // optional predicate whitelist
  direction:  'out',              // 'out' | 'in' | 'both' (default 'out')
  edgeFilter: (e) => !e.superseded_by_id  // optional per-edge predicate
});

reach.nodes              // hydrated entities reachable from alice
reach.edges              // edge documents traversed
reach.paths              // [[seedId, edgeId, nodeId, edgeId, nodeId, ...], ...]
reach.complete           // false if a budget was hit
reach.incompleteReason   // 'time' | 'results' | undefined
```

**Cycle handling.** A per-traversal visited-set on node $IDs guarantees BFS terminates on cyclic graphs. Edges aren't deduplicated across paths (a path-deduped result loses information).

**Direction semantics.** `'out'` follows the from→to fields; `'in'` follows to→from; `'both'` picks whichever endpoint isn't the current node, which is the right behavior for symmetric edges (lexicalEdge co-occurrence) but produces both endpoints on traversal so the visited-set still terminates correctly.

**Phantom adjacency.** If an edge $ID is in the GraphIndex but the underlying document was deleted (shouldn't happen given middleware sync, but the resilience contract gates it), the BFS skips silently rather than throwing.

**Budget enforcement.** Time budgets are checked between hop iterations (not per-edge) so measurement overhead doesn't dominate small graphs. Results budget is checked after every node addition.

---

## Graph algorithms (UC-G5)

`db.algo.{name}` is a separate namespace for parameter-rich algorithms over registered edge collections.

### `db.algo.degree({...})`

Degree centrality — for every node in `collection`, sum its incoming + outgoing edges in the edge collection `via`. Optionally weighted by a numeric edge attribute.

```js
const central = await db.algo.degree({
  collection: 'kgEntity',          // node collection
  via:        'kgTriple',          // edge collection (must be registered $edge)
  weighted:   'co_occurrence_count',  // optional — sum this field; default counts
  top:        50                    // optional top-k cap
});
// → [{ entity, degree }, ...] sorted by degree desc
```

Edge hydration is cached so an edge counted on both sides reads at most once. Phantom adjacency entries (id present but doc missing) are silently skipped per the UC-G5 resilience criterion.

PPR (`db.algo.ppr`) is scoped for v3 per spec §6.3 / §7.5.

---

## Limitations (v1)

- **No supersession defaults.** `$supersession` field is recognized but predicate reads don't auto-filter by it; that comes with the chain-method slice.
- **No confidence/provenance defaults.** Same — recognized in schema, not yet wired into reads.
- **Polymorphic `'ref|string'` targets** are reserved for the next slice. v1 honors single-collection refs only.
- **GraphIndex is in-memory only.** Adjacency is rebuilt from edge documents on first access after restart (via the existing per-write sync once schemas are re-declared). Persistent adjacency lands with the snapshot slice for graph state.
- **No PPR.** `db.algo.ppr` is v3 work per spec §6.3.
- **`.expand` edgeFilter is function-form only.** Object-form filters (with operators like `{$ne: ...}`) work via the shared compileFilter — but the expand surface accepts a function for now, so callers wanting operator filters compose `compileFilter(obj)` themselves.

---

## See also

- [`engine/graph-index.js`](../engine/graph-index.js) — adjacency maps + serialize/deserialize hooks
- [`engine/predicate-proxy.js`](../engine/predicate-proxy.js) — `resolvePredicateAccess` and the PredicateAccessor
- [`engine/schema-registry.js`](../engine/schema-registry.js) — `$edge` parsing, reserved-name check, predicate→edge routing
- [`tests/e2e/graph.test.js`](../tests/e2e/graph.test.js) — UC-G1 acceptance suite
