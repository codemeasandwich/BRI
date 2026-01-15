## Directory Structure

```
src/
├── symbols.js
├── traverse.js
├── path.js
├── match.js
├── apply.js
└── watch.js
```

## Files

### `symbols.js`

Defines the UNDECLARED symbol used to represent deleted or non-existent properties in change tuples.

### `traverse.js`

Object traversal utilities.
- `isPlainObject(value)` - Check if value is traversable (excludes Date, Error, Set, Map)
- `flattenToPathValues(obj, path, oldRef)` - Flatten nested object to [path, value, oldRef] tuples

### `path.js`

Path-based navigation utilities.
- `getByPath(obj, path)` - Get value at array path
- `pathStartsWith(prefix, fullPath)` - Check path prefix
- `pathEquals(path1, path2)` - Compare paths for equality

### `match.js`

Object comparison utilities.
- `isPartialMatch(subset, source)` - Check if all subset keys match in source
- `isDeepEqual(a, b)` - Deep equality check for objects, arrays, primitives

### `apply.js`

Change application.
- `applyChanges(changes, source)` - Create new object with changes applied

### `watch.js`

Proxy-based change tracking.
- `createChangeTracker(target, options)` - Returns proxy with .getChanges(), .save(), .clearChanges()
