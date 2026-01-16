# Bootstrap Data Mechanism

## Overview

A mechanism to populate the database with initial data when it starts completely empty. This supports seeding reference data, default configurations, demo data, and migrations from other systems.

## Use Cases

1. **Initial Deployment**: Seed required reference data (roles, permissions, settings)
2. **Development Setup**: Quickly populate dev databases with test data
3. **Demo Environments**: Pre-populate with sample data for demonstrations
4. **Multi-Tenant Setup**: Initialize tenant-specific base data
5. **Migration**: Import data from external systems on first run
6. **Schema Evolution**: Apply data transformations on upgrade

## Current State

BRI has no bootstrap mechanism. Empty databases start completely empty with no way to automatically seed data.

## Proposed Architecture

### 1. Bootstrap File Structure

```
data/
├── bootstrap/
│   ├── manifest.jss           # Bootstrap configuration
│   ├── seeds/
│   │   ├── 001-roles.jss      # Numbered seed files
│   │   ├── 002-permissions.jss
│   │   ├── 003-settings.jss
│   │   └── 004-demo-users.jss
│   ├── migrations/
│   │   ├── v1-to-v2.js        # Data migration scripts
│   │   └── v2-to-v3.js
│   └── imports/
│       └── legacy-data.json   # External data imports
```

### 2. Bootstrap Manifest

**File**: `data/bootstrap/manifest.jss`

```javascript
{
  version: "1.0",
  name: "BRI Default Bootstrap",
  description: "Initial data setup for BRI database",

  // When to run bootstrap
  triggers: {
    onEmpty: true,              // Run when database is empty
    onVersion: null,            // Run when schema version changes
    always: false               // Run on every startup (dev only)
  },

  // Seed files to execute in order
  seeds: [
    {
      file: "seeds/001-roles.jss",
      required: true,           // Fail startup if seed fails
      idempotent: true,         // Safe to run multiple times
      condition: null           // Optional condition expression
    },
    {
      file: "seeds/002-permissions.jss",
      required: true,
      idempotent: true
    },
    {
      file: "seeds/003-settings.jss",
      required: true,
      idempotent: true
    },
    {
      file: "seeds/004-demo-users.jss",
      required: false,
      idempotent: true,
      condition: "env.NODE_ENV !== 'production'"  // Only in non-prod
    }
  ],

  // Post-seed validations
  validations: [
    {
      type: "ROLE",
      minCount: 3,
      required: ["ADMIN", "USER", "GUEST"]
    }
  ],

  // Metadata
  _meta: {
    createdAt: "2024-01-01T00:00:00Z",
    author: "system"
  }
}
```

### 3. Seed File Format

**File**: `seeds/001-roles.jss`

```javascript
{
  version: "1.0",
  type: "ROLE",                  // Entity type to create
  description: "Default role definitions",
  idempotent: true,              // Uses upsert behavior

  // Data to seed
  data: [
    {
      $ID: "ROLE_admin001",      // Fixed ID for idempotent seeds
      name: "Administrator",
      permissions: ["*"],
      description: "Full system access",
      system: true               // Cannot be deleted
    },
    {
      $ID: "ROLE_user0001",
      name: "User",
      permissions: ["read:own", "write:own"],
      description: "Standard user access",
      system: true
    },
    {
      $ID: "ROLE_guest001",
      name: "Guest",
      permissions: ["read:public"],
      description: "Read-only public access",
      system: true
    }
  ],

  // Optional: relationships to establish after creation
  relationships: [],

  // Optional: post-seed script
  afterSeed: null
}
```

**File**: `seeds/004-demo-users.jss`

```javascript
{
  version: "1.0",
  type: "USER",
  description: "Demo users for development",
  idempotent: true,

  // Generator function for dynamic data
  generator: {
    count: 10,
    template: {
      name: "{{faker.person.fullName}}",
      email: "{{faker.internet.email}}",
      role: "ROLE_user0001",
      status: "active",
      createdAt: "{{now}}"
    }
  },

  // Or static data
  data: [
    {
      $ID: "USER_demo0001",
      name: "Demo Admin",
      email: "admin@demo.local",
      role: "ROLE_admin001",
      password: "{{env.DEMO_ADMIN_PASSWORD || 'demo123'}}"
    }
  ]
}
```

### 4. Bootstrap Manager

**File**: `bootstrap/manager.js`

```javascript
export class BootstrapManager {
  constructor(db, options = {}) {
    this.db = db;
    this.bootstrapDir = options.bootstrapDir || './data/bootstrap';
    this.manifestPath = path.join(this.bootstrapDir, 'manifest.jss');
    this.executed = [];
    this.errors = [];
  }

  // Check if bootstrap should run
  async shouldRun() {
    const manifest = await this.loadManifest();
    if (!manifest) return false;

    if (manifest.triggers.always) return true;
    if (manifest.triggers.onEmpty && await this.isDatabaseEmpty()) return true;
    if (manifest.triggers.onVersion && await this.isVersionChanged()) return true;

    return false;
  }

  // Execute bootstrap process
  async execute() {
    console.log('BRI: Starting bootstrap...');

    const manifest = await this.loadManifest();
    if (!manifest) {
      console.log('BRI: No bootstrap manifest found');
      return { success: true, seeded: 0 };
    }

    const results = {
      success: true,
      seeded: 0,
      skipped: 0,
      errors: []
    };

    // Execute seeds in order
    for (const seedConfig of manifest.seeds) {
      try {
        // Check condition
        if (seedConfig.condition && !this.evaluateCondition(seedConfig.condition)) {
          console.log(`BRI: Skipping ${seedConfig.file} (condition not met)`);
          results.skipped++;
          continue;
        }

        const seedResult = await this.executeSeed(seedConfig);
        results.seeded += seedResult.created;

        this.executed.push({
          file: seedConfig.file,
          ...seedResult
        });

      } catch (error) {
        if (seedConfig.required) {
          results.success = false;
          results.errors.push({ file: seedConfig.file, error: error.message });
          throw new BootstrapError(`Required seed failed: ${seedConfig.file}`, error);
        } else {
          console.warn(`BRI: Optional seed failed: ${seedConfig.file}`, error);
          results.errors.push({ file: seedConfig.file, error: error.message });
        }
      }
    }

    // Run validations
    if (manifest.validations) {
      await this.runValidations(manifest.validations);
    }

    // Record bootstrap completion
    await this.recordBootstrap(results);

    console.log(`BRI: Bootstrap complete. Seeded ${results.seeded} records.`);
    return results;
  }

  // Execute a single seed file
  async executeSeed(seedConfig) {
    const seedPath = path.join(this.bootstrapDir, seedConfig.file);
    const seed = await this.loadSeedFile(seedPath);

    let data = seed.data || [];

    // Generate data if generator specified
    if (seed.generator) {
      data = await this.generateData(seed.generator);
    }

    // Resolve templates in data
    data = await this.resolveTemplates(data);

    const result = { created: 0, updated: 0, skipped: 0 };

    for (const item of data) {
      const existing = item.$ID ? await this.db.get[seed.type.toLowerCase()](item.$ID) : null;

      if (existing && seedConfig.idempotent) {
        // Update if changed
        const changed = this.hasChanges(existing, item);
        if (changed) {
          Object.assign(existing, item);
          await existing.save('BOOTSTRAP');
          result.updated++;
        } else {
          result.skipped++;
        }
      } else if (!existing) {
        // Create new
        await this.db.add[seed.type.toLowerCase()](item);
        result.created++;
      }
    }

    // Execute relationships
    if (seed.relationships) {
      await this.establishRelationships(seed.relationships);
    }

    // Run after-seed script
    if (seed.afterSeed) {
      await this.runAfterSeed(seed.afterSeed);
    }

    return result;
  }

  // Check if database is empty
  async isDatabaseEmpty() {
    // Check for any documents (excluding system)
    const stats = await this.db._store.stats();
    return stats.totalDocuments === 0;
  }

  // Template resolution
  async resolveTemplates(data) {
    // Supports: {{env.VAR}}, {{now}}, {{uuid}}, {{faker.*}}
  }

  // Data generation
  async generateData(generator) {
    const items = [];
    for (let i = 0; i < generator.count; i++) {
      const item = await this.resolveTemplates({ ...generator.template });
      items.push(item);
    }
    return items;
  }
}
```

### 5. Programmatic Bootstrap API

```javascript
// In application code
const db = await createDB({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 },

  bootstrap: {
    enabled: true,
    dir: './bootstrap',           // Bootstrap directory
    onEmpty: true,                // Run when empty
    failOnError: true,            // Fail startup if bootstrap fails
    dryRun: false                 // Log but don't execute
  }
});

// Or manual bootstrap
await db.bootstrap.run();

// Check bootstrap status
const status = await db.bootstrap.status();
// { lastRun: Date, seedsExecuted: [...], version: "1.0" }

// Reset bootstrap (dev only)
await db.bootstrap.reset();

// Seed specific file
await db.bootstrap.seed('seeds/001-roles.jss');
```

### 6. CLI Bootstrap Commands

```bash
# Run bootstrap manually
bri bootstrap run

# Run specific seed
bri bootstrap seed seeds/001-roles.jss

# Validate bootstrap config
bri bootstrap validate

# Generate seed file from existing data
bri bootstrap export --type USER --output seeds/users.jss

# Reset bootstrap state (dev only)
bri bootstrap reset --force

# Dry run
bri bootstrap run --dry-run
```

### 7. Integration with Startup

**Modified `client/index.js`**:

```javascript
export async function createDB(options = {}) {
  const store = await createStore({
    type: options.storeType || 'inhouse',
    config: options.storeConfig
  });

  await store.connect();

  const engine = createEngine(store);
  const db = createDBInterface(engine, store);

  // Bootstrap if configured
  if (options.bootstrap?.enabled !== false) {
    const bootstrapManager = new BootstrapManager(db, {
      bootstrapDir: options.bootstrap?.dir || './data/bootstrap',
      ...options.bootstrap
    });

    if (await bootstrapManager.shouldRun()) {
      const result = await bootstrapManager.execute();

      if (!result.success && options.bootstrap?.failOnError !== false) {
        await store.disconnect();
        throw new BootstrapError('Bootstrap failed', result.errors);
      }
    }
  }

  return db;
}
```

### 8. Seed File Templates

#### Reference Data Seed
```javascript
// seeds/001-settings.jss
{
  version: "1.0",
  type: "SETTING",
  description: "System settings",
  idempotent: true,

  data: [
    {
      $ID: "SETT_app00001",
      key: "app.name",
      value: "My Application",
      type: "string",
      editable: true
    },
    {
      $ID: "SETT_app00002",
      key: "app.maxUsers",
      value: 1000,
      type: "number",
      editable: true
    },
    {
      $ID: "SETT_app00003",
      key: "app.features",
      value: {
        darkMode: true,
        notifications: true,
        analytics: false
      },
      type: "object",
      editable: true
    }
  ]
}
```

#### Relationship Seed
```javascript
// seeds/005-user-roles.jss
{
  version: "1.0",
  type: "USER",
  description: "Assign roles to users",
  idempotent: true,

  // Reference existing entities
  references: {
    adminRole: { type: "ROLE", query: { name: "Administrator" } },
    userRole: { type: "ROLE", query: { name: "User" } }
  },

  // Update existing records
  updates: [
    {
      query: { email: "admin@demo.local" },
      set: { role: "{{ref.adminRole.$ID}}" }
    }
  ],

  // Or bulk assign
  bulkUpdates: [
    {
      filter: { status: "active", role: null },
      set: { role: "{{ref.userRole.$ID}}" }
    }
  ]
}
```

#### External Import Seed
```javascript
// seeds/010-import-legacy.jss
{
  version: "1.0",
  type: "USER",
  description: "Import from legacy system",
  idempotent: true,

  // Import from external file
  import: {
    source: "../imports/legacy-users.json",
    format: "json",

    // Field mapping
    mapping: {
      "legacy_id": null,         // Ignore
      "full_name": "name",
      "email_address": "email",
      "created_date": "createdAt",
      "is_active": { field: "status", transform: "v => v ? 'active' : 'inactive'" }
    },

    // Deduplication
    dedupeKey: "email",

    // Validation
    validate: {
      email: "required|email",
      name: "required|min:2"
    }
  }
}
```

### 9. Bootstrap State Tracking

**System document**: `BSTR_state001`

```javascript
{
  $ID: "BSTR_state001",
  type: "BOOTSTRAP_STATE",
  version: "1.0",

  executions: [
    {
      timestamp: Date,
      manifestVersion: "1.0",
      seeds: [
        { file: "seeds/001-roles.jss", created: 3, updated: 0, skipped: 0 },
        { file: "seeds/002-permissions.jss", created: 15, updated: 0, skipped: 0 }
      ],
      success: true,
      duration: 1234
    }
  ],

  lastRun: Date,
  schemaVersion: "1.0",

  // Checksums to detect changes
  seedChecksums: {
    "seeds/001-roles.jss": "sha256:abc123...",
    "seeds/002-permissions.jss": "sha256:def456..."
  }
}
```

### 10. Error Handling

```javascript
// bootstrap/errors.js
export class BootstrapError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'BootstrapError';
    this.cause = cause;
  }
}

export class SeedValidationError extends BootstrapError {
  constructor(file, errors) {
    super(`Seed validation failed: ${file}`);
    this.file = file;
    this.errors = errors;
  }
}

export class SeedExecutionError extends BootstrapError {
  constructor(file, record, cause) {
    super(`Seed execution failed: ${file}`);
    this.file = file;
    this.record = record;
    this.cause = cause;
  }
}
```

### 11. Validation Rules

```javascript
// seeds/001-roles.jss with validation
{
  version: "1.0",
  type: "ROLE",

  // Schema validation for seed data
  schema: {
    name: { type: "string", required: true, minLength: 2 },
    permissions: { type: "array", items: "string", required: true },
    description: { type: "string" }
  },

  data: [...]
}
```

### 12. Conditional Execution

```javascript
{
  version: "1.0",
  type: "USER",

  // Environment conditions
  conditions: {
    env: ["development", "staging"],  // Only these environments
    notEnv: ["production"],
    custom: "db.count('USER') < 100"  // Custom expression
  },

  data: [...]
}
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `bootstrap/manager.js` | Create | Bootstrap orchestration |
| `bootstrap/seed-executor.js` | Create | Seed file execution |
| `bootstrap/template-resolver.js` | Create | Template variable resolution |
| `bootstrap/validator.js` | Create | Seed validation |
| `bootstrap/errors.js` | Create | Bootstrap errors |
| `bootstrap/index.js` | Create | Module exports |
| `client/index.js` | Modify | Integrate bootstrap on startup |
| `client/proxy.js` | Modify | Add db.bootstrap namespace |

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bootstrap.enabled` | boolean | true | Enable bootstrap |
| `bootstrap.dir` | string | ./data/bootstrap | Bootstrap directory |
| `bootstrap.onEmpty` | boolean | true | Run when database empty |
| `bootstrap.failOnError` | boolean | true | Fail startup on error |
| `bootstrap.dryRun` | boolean | false | Log without executing |
| `bootstrap.parallel` | boolean | false | Run seeds in parallel |
| `bootstrap.timeout` | number | 60000 | Seed timeout (ms) |
