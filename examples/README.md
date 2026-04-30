# Runnable §F demos (repository root)

Two **Node ESM** scripts exercise memory-tier and knowledge-tier flows described in specification **§F**. They import fixture helpers from **`tests/fixtures/`** and open a **throwaway store** under the OS temp directory so nothing pollutes the repo.

| Script | Flow |
|--------|------|
| [`memory-artifact-lifecycle.js`](memory-artifact-lifecycle.js) | Vectors, `.where` + `.near`, `.confidence`, supersession, cascade |
| [`knowledge-graph-triples.js`](knowledge-graph-triples.js) | Predicates, inverse edges, confidence filters, expand |

## How to run

From the **repository root** (so `../src/...` and `../tests/fixtures/...` resolve):

```bash
node examples/memory-artifact-lifecycle.js
node examples/knowledge-graph-triples.js
```

Each process prints step-by-step console output and deletes its temp **`dataDir`** on exit code **0**.

## Relation to docs and tests

- **Authoritative correctness** stays in **`tests/e2e/`** (no duplicate harness here).
- Narrative snippets without imports live in **[`docs/illustrative-scenarios.md`](../docs/illustrative-scenarios.md)**.
- These files are **`#!/usr/bin/env node`** runnable documentation for reviewers and adopters.

## Imports

Examples load READY helpers via **`../src/client/ready-connection.js`** and shared schemas/embeddings fixtures—keep that path aligned whenever the checkout layout moves.
