## Directory Structure

```
tests/jest/
├── files.md
└── global-teardown.js
```

## Files

### `global-teardown.js`

Registered from **`jest.config.js`** as **`globalTeardown`**. After all workers exit it removes every
immediate child **`test-data-*`** directory at the repo root (**`removeRepoRootTestDataDirs`**), and
 exposes **`removeRepoRootTestArtifact`** for single-directory selective cleanup mid-suite.
