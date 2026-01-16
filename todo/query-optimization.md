# Smart Query Optimization

## Overview

Optimize queries by analyzing callback functions to determine which fields are actually needed and moving filter logic from client-side to database-side execution. This reduces data transfer and processing overhead.

## Current State

BRI currently:
- Returns full objects for all queries
- Executes filter functions client-side after fetching all data
- Has no field projection/selection
- No query analysis or optimization

## Use Cases

1. **Field Selection**: Only fetch fields that the callback destructures
2. **DB-Side Filtering**: Execute filter functions on the database side
3. **Reduced Memory**: Avoid loading unused fields into memory
4. **Network Optimization**: Send less data over the wire for remote deployments

---

## Proposed Architecture

### 1. Field Selection from Callback Parsing

Analyze the `.then()` callback source to determine which fields the caller actually needs:

```javascript
// Full object requested - fetch all fields
.then(objDB => { ... })

// Destructured - only fetch 'name' and 'address'
.then(({ name, address }) => { ... })
```

### 2. Filter Function Optimization

Move filter logic from client-side to DB-side when possible:

```javascript
// Client-side filter (current)
.get.userS(({ age }) => retirement < age)

// DB-side filter with injected dependencies
.get.userS(({ age }, retirement) => retirement < age, retirement)

// DB-side filter with literal value
.get.userS(({ age }) => 64 < age)
```

**Pattern**: Pass filter function + N dependencies to enable server-side execution.

---

## Implementation

### 1. Callback Parser

**File**: `engine/query/callback-parser.js`

```javascript
export class CallbackParser {
  // Extract destructured field names from callback
  parseDestructuredFields(callback) {
    const source = callback.toString();

    // Match arrow function destructuring: ({ field1, field2 }) =>
    const arrowMatch = source.match(/^\s*\(\s*\{\s*([^}]+)\s*\}\s*\)\s*=>/);
    if (arrowMatch) {
      return this.parseFieldList(arrowMatch[1]);
    }

    // Match function destructuring: function({ field1, field2 })
    const funcMatch = source.match(/^function\s*\(\s*\{\s*([^}]+)\s*\}\s*\)/);
    if (funcMatch) {
      return this.parseFieldList(funcMatch[1]);
    }

    // Match renamed destructuring: ({ field1: renamed1 }) =>
    const renamedMatch = source.match(/^\s*\(\s*\{([^}]+)\}\s*\)\s*=>/);
    if (renamedMatch) {
      return this.parseFieldListWithRenames(renamedMatch[1]);
    }

    // No destructuring found - caller wants full object
    return null;
  }

  // Parse comma-separated field list
  parseFieldList(fieldStr) {
    return fieldStr
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0)
      .map(f => {
        // Handle rename syntax: originalName: newName
        const colonIdx = f.indexOf(':');
        if (colonIdx > -1) {
          return f.substring(0, colonIdx).trim();
        }
        // Handle default value: fieldName = defaultValue
        const eqIdx = f.indexOf('=');
        if (eqIdx > -1) {
          return f.substring(0, eqIdx).trim();
        }
        return f;
      });
  }

  // Check if callback uses full object (not just destructured fields)
  usesFullObject(callback) {
    const source = callback.toString();

    // Look for variable name usage beyond just destructured access
    // e.g., obj.something or passing obj to another function
    const paramMatch = source.match(/^\s*\(?\s*(\w+)\s*\)?\s*=>/);
    if (paramMatch) {
      const paramName = paramMatch[1];
      // Check if param is used as full object anywhere
      const usagePattern = new RegExp(`${paramName}\\s*[.\\[]|\\(\\s*${paramName}\\s*\\)`);
      return usagePattern.test(source);
    }

    return true;  // Assume full object needed if we can't determine
  }

  // Extract external dependencies from filter function
  extractDependencies(filterFn) {
    const source = filterFn.toString();
    const dependencies = [];

    // Match second parameter onwards in arrow function
    // ({ field }, dep1, dep2) => ...
    const paramsMatch = source.match(/^\s*\([^)]+,\s*([^)]+)\)\s*=>/);
    if (paramsMatch) {
      const deps = paramsMatch[1].split(',').map(d => d.trim());
      dependencies.push(...deps);
    }

    return dependencies;
  }
}
```

### 2. Query Optimizer

**File**: `engine/query/optimizer.js`

```javascript
import { CallbackParser } from './callback-parser.js';

export class QueryOptimizer {
  constructor() {
    this.parser = new CallbackParser();
  }

  // Optimize query based on callback analysis
  optimize(queryConfig) {
    const { callback, filter } = queryConfig;
    const optimizations = {
      fields: null,       // Fields to project (null = all)
      serverFilter: null, // Filter to run server-side
      clientFilter: null, // Filter to run client-side (fallback)
      dependencies: []    // External values needed for filter
    };

    // Analyze callback for field selection
    if (callback) {
      const fields = this.parser.parseDestructuredFields(callback);
      if (fields && !this.parser.usesFullObject(callback)) {
        optimizations.fields = this.ensureRequiredFields(fields);
      }
    }

    // Analyze filter for server-side execution
    if (filter) {
      const analysis = this.analyzeFilter(filter);
      if (analysis.canRunServerSide) {
        optimizations.serverFilter = filter;
        optimizations.dependencies = analysis.dependencies;
      } else {
        optimizations.clientFilter = filter;
      }
    }

    return optimizations;
  }

  // Ensure $ID and required metadata fields are included
  ensureRequiredFields(fields) {
    const required = ['$ID', 'updatedAt', 'createdAt'];
    const fieldSet = new Set(fields);
    for (const req of required) {
      fieldSet.add(req);
    }
    return Array.from(fieldSet);
  }

  // Analyze filter function for server-side execution
  analyzeFilter(filterFn) {
    const source = filterFn.toString();
    const dependencies = this.parser.extractDependencies(filterFn);

    // Can run server-side if:
    // 1. Only uses destructured fields from the entity
    // 2. Only uses literals or provided dependencies
    // 3. Doesn't call external functions
    // 4. Doesn't access closures

    const canRunServerSide = this.isSafeForServerExecution(source, dependencies);

    return {
      canRunServerSide,
      dependencies
    };
  }

  // Check if filter is safe for server-side execution
  isSafeForServerExecution(source, providedDeps) {
    // Unsafe patterns
    const unsafePatterns = [
      /\bawait\b/,           // Async operations
      /\bfetch\b/,           // Network calls
      /\brequire\b/,         // Module loading
      /\bimport\b/,          // Dynamic imports
      /\beval\b/,            // Code evaluation
      /\bFunction\b/,        // Function constructor
      /\bthis\b/,            // Context access
      /\bglobal\b/,          // Global access
      /\bprocess\b/,         // Process access
      /\bconsole\b/,         // Console access
    ];

    for (const pattern of unsafePatterns) {
      if (pattern.test(source)) {
        return false;
      }
    }

    return true;
  }
}
```

### 3. Optimized Store Operations

**File**: `engine/query/optimized-store.js`

```javascript
import { QueryOptimizer } from './optimizer.js';

export class OptimizedStore {
  constructor(store, options = {}) {
    this.store = store;
    this.optimizer = new QueryOptimizer();
    this.enabled = options.enabled !== false;
  }

  // Get with field projection
  async getProjected(key, fields) {
    const full = await this.store.get(key);
    if (!full || !fields) return full;

    const projected = {};
    for (const field of fields) {
      if (field in full) {
        projected[field] = full[field];
      }
    }
    return projected;
  }

  // Get multiple with optimizations
  async getManyOptimized(type, options = {}) {
    const { filter, callback, dependencies = [] } = options;

    // Analyze and optimize
    const optimizations = this.enabled
      ? this.optimizer.optimize({ filter, callback })
      : { fields: null, serverFilter: null, clientFilter: filter };

    // Get all keys for type
    const keys = await this.store.sMembers(`IDX_${type}`);

    // Fetch entities (with optional projection)
    let entities = await Promise.all(
      keys.map(key => this.getProjected(key, optimizations.fields))
    );

    entities = entities.filter(Boolean);

    // Apply server-side filter
    if (optimizations.serverFilter) {
      entities = this.applyFilter(entities, optimizations.serverFilter, dependencies);
    }

    // Apply client-side filter (fallback)
    if (optimizations.clientFilter) {
      entities = entities.filter(e => optimizations.clientFilter(e));
    }

    return entities;
  }

  // Apply filter function to entities
  applyFilter(entities, filterFn, dependencies) {
    return entities.filter(entity => {
      try {
        return filterFn(entity, ...dependencies);
      } catch (error) {
        console.warn('Filter execution failed:', error);
        return false;
      }
    });
  }
}
```

### 4. API Integration

```javascript
// Usage with automatic optimization
const users = await db.get.userS(({ name, email }) => name.startsWith('A'));
// Optimizer detects:
// - Only 'name' and 'email' fields needed (plus $ID, updatedAt)
// - Filter can run server-side (only uses 'name' field)

// Usage with explicit dependencies
const minAge = 21;
const adults = await db.get.userS(
  ({ age }, minAge) => age >= minAge,
  minAge  // Pass dependency explicitly
);

// Disable optimization for specific query
const allUsers = await db.get.userS(null, { optimize: false });
```

---

## Query Analysis API

```javascript
// Analyze a query without executing
const analysis = db.query.analyze(
  'user',
  ({ name, age }) => age > 18
);

/* Returns:
{
  fields: ['name', 'age', '$ID', 'updatedAt', 'createdAt'],
  canOptimize: true,
  serverFilter: true,
  estimatedReduction: '60%'  // Based on field count vs total
}
*/

// Get optimization statistics
const stats = db.query.stats();
/* Returns:
{
  queriesOptimized: 150,
  queriesUnoptimized: 20,
  avgFieldReduction: 0.45,
  serverFiltersExecuted: 120
}
*/
```

---

## Configuration

```javascript
const db = await createDB({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 },

  queryOptimization: {
    enabled: true,

    // Field projection
    fieldProjection: true,
    alwaysIncludeFields: ['$ID', 'updatedAt', 'createdAt'],

    // Filter optimization
    serverSideFilters: true,
    maxFilterComplexity: 100,  // AST node limit

    // Logging
    logOptimizations: false,
    logUnoptimizable: true
  }
});
```

---

## Limitations

| Limitation | Description |
|------------|-------------|
| Closure access | Filters using closures cannot run server-side |
| Async filters | Async filter functions not supported server-side |
| Complex callbacks | Deeply nested destructuring may not be detected |
| External calls | Filters calling external functions stay client-side |

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `engine/query/callback-parser.js` | Create | Parse callback functions |
| `engine/query/optimizer.js` | Create | Query optimization logic |
| `engine/query/optimized-store.js` | Create | Optimized store operations |
| `engine/query/index.js` | Create | Module exports |
| `engine/operations.js` | Modify | Integrate optimizer |
| `client/proxy.js` | Modify | Add query analysis API |

## Dependencies

None - pure JavaScript implementation

## Priority

**LOW** - Nice-to-have optimization. Should be implemented after core features and memoization cache. Provides performance benefits but not critical for functionality.
