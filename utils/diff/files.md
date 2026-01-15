## Directory Structure

```
diff/
├── index.js
└── src/
    ├── symbols.js
    ├── traverse.js
    ├── path.js
    ├── match.js
    ├── apply.js
    └── watch.js
```

## Files

### `index.js`

Main entry point re-exporting all diff utilities.

**Exports:**
- `UNDECLARED` - Symbol for deleted/non-existent properties
- `createChangeTracker` - Proxy-based change observation
- `applyChanges` - Apply change tuples to objects
- `getByPath`, `pathStartsWith`, `pathEquals` - Path utilities
- `flattenToPathValues`, `isPlainObject` - Object traversal
- `isPartialMatch`, `isDeepEqual` - Comparison utilities
