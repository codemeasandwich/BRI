## Directory Structure

```
tests/jest/
├── README.md
├── files.md
└── global-teardown.js
```

## Files

### `README.md`

Why **`global-teardown.js`** exists and how it ties to **`jest.config.js`**.

### `global-teardown.js`

Registered from **`jest.config.js`** as **`globalTeardown`**. After all workers exit it removes every
immediate child **`test-data-*`** directory at the repo root (**`removeRepoRootTestDataDirs`**), and
 exposes **`removeRepoRootTestArtifact`** for single-directory selective cleanup mid-suite.
