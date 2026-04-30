# Repository scripts

Developer automation that is **not** part of the shipped **`bri-db`** package surface.

| Script | Role |
|--------|------|
| **`jsdoc-check.js`** — `npm run jsdoc-check` | Ensures every exported symbol under configured **`src/*`** trees has a preceding JSDoc block. |
| **`sync-test-data-docs.mjs`** | Optional maintenance utility for keeping test-data documentation in sync (see file header). |
| **`publish.sh`** | Release helper for maintainers (read the script before use). |

Scripts assume execution from the repo root unless their own header says otherwise.
