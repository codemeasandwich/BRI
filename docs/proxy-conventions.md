# Proxy conventions — entity property access lookup algorithm

When user code accesses `entity.{name}`, the reactive entity proxy
runs through a fixed lookup order to decide what to return. This page
is the reference for that algorithm; debug "why does `entity.foo`
throw?" by walking the steps below.

## The lookup algorithm (spec §3.5)

Given an entity proxy and a property access `entity.{name}`, the
property is resolved in this order. The first matching step wins; later
steps are not considered.

1. **`$`-prefixed names + known instance methods** (`$ID`, `save`,
   `toObject`, `toJSON`, `toJSS`) → return the actual property/method
   from the entity's body.
2. **`and`** → return the existing single-hop ref-population proxy
   (preserves `entity.and.author` from earlier Bri).
3. **Reserved chain method names** (`history`, `asOf`, `chain`,
   `expand`, `confidence`, `withProvenance`, etc.) — see the full
   reserved list below — return the corresponding handler bound to the
   entity. (Schema declarations colliding with these names are caught
   at load time, not at access.)
4. **`inverse`** → return the InverseProxy. The next access on it is
   treated as an inverse predicate: `acme.inverse.works_at` →
   employees.
5. **`related`** → return the RelatedAccessor. Awaitable; resolves to a
   flat list of every outgoing target across every registered
   predicate.
6. **Declared field on this collection** → return the raw field value.
   This precedence means a field named `name` on the schema wins over
   any predicate-routing fallback.
7. **Registered predicate where this collection is a valid `from`
   endpoint** → return the PredicateAccessor. Callable for write,
   thenable for read, has `.$` and `.limit`.
8. **Otherwise** → throw `BriProxyError` with code
   `PREDICATE_NOT_REGISTERED` and a diagnostic message listing the
   valid options on this entity's collection.

Order matters: reserved names beat predicates, so a schema declaring a
predicate named `history` would fail at schema load (step 3 above)
before any access hit the proxy.

## Reserved names list (spec §0.4)

```
$  history  asOf  chain  expand  inverse  related
confidence  withProvenance
near  match  where  combine  limit  count  groupBy  distinct  having
touching  hydrate  toArray  first
save  toObject  toJSON  toJSS  and
```

Source: `engine/schema-edge-declare.js` → `RESERVED_PROXY_NAMES`. The
list is FROZEN as part of v1 delivery; additions are breaking changes
requiring a major version bump and migration path.

## Schema-load validation

The schema loader rejects:
- predicates colliding with the reserved set
- ref field names colliding with the reserved set (spec §2.1.4)
- the same predicate registered on two edge collections from a single
  subject collection (`PREDICATE_AMBIGUOUS`)
- `$supersession` / `$confidence` / `$provenance` flags pointing to
  fields not declared on the collection (`INDEX_FIELD_NOT_DECLARED`)

Catch these at startup so deployments fail fast.

## Inverse vs related vs expand

Three different surfaces for "what's connected to me?" — pick by intent:

| Surface | Returns | When to use |
|---|---|---|
| `entity.{predicate}` | targets via this predicate (one hop, one predicate) | "Who does Alice know?" |
| `entity.inverse.{predicate}` | subjects pointing TO this entity via the predicate | "Who works at Acme?" |
| `entity.related` | flat list across every predicate (one hop, all predicates) | "What is this connected to?" |
| `entity.expand({ ... })` | parameterized BFS — hops, edge filter, direction, budget | "Show me the 2-hop neighbourhood with budget caps" |

Each composes with `.confidence(t)` / `.history` / `.withProvenance`
chain methods when the schema declares the matching `$-flag`.

## Debugging "why did `entity.foo` throw?"

1. Is `foo` in the reserved-names list? It's a chain method or
   accessor. Check whether the schema declares the matching `$-flag`
   (e.g. `.confidence` requires `$confidence`).
2. Is `foo` declared as a field on the entity's collection? It returns
   the raw field value. Check the value, not the access path.
3. Is `foo` a registered predicate where this entity's collection is a
   valid subject? It returns the PredicateAccessor.
4. Otherwise the error message lists the valid options. Either rename
   the access or extend the schema.

The thrown error carries `code: 'PREDICATE_NOT_REGISTERED'` so call
sites can catch it with the typed BriProxyError class and switch on the
code rather than regexing the message.
