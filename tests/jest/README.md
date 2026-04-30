# Jest wiring (`tests/jest`)

Hosts **`global-teardown.js`**, registered from **[`jest.config.js`](../../jest.config.js)** as **`globalTeardown`**.

After the suite finishes it deletes ephemeral **`test-data-*`** directories at the repo root so CI/local runs stay repeatable. Selective cleanup helpers are also exported for suites that opt into mid-run hygiene.

See **[`files.md`](files.md)** for call graph and export list.
