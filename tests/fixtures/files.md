## Directory Structure

```
fixtures/
├── embeddings.js
├── schemas.js
└── triples.js
```

## Files

### `embeddings.js`

Synthetic embedding vectors for vector-search E2E tests — fixed dims, deterministic shapes.

### `schemas.js`

Shared Bri schema snippets (KG triple schema, entity types, etc.) imported by scenario tests.

### `triples.js`

Knowledge-graph fixture factories — `entityRecords`, `tripleRecords`, `loadKGFixture` — for UC-G coverage with confidence and provenance populated.
