# Remote Configuration Server Settings

## Overview

A mechanism to configure BRI database instances from a remote configuration server, enabling centralized management of database settings across multiple deployments. This supports dynamic configuration updates, environment-specific settings, and configuration versioning.

## Use Cases

1. **Multi-Environment Deployment**: Different configs for dev/staging/prod
2. **Fleet Management**: Centralized control of multiple BRI instances
3. **Dynamic Tuning**: Adjust memory limits, snapshot intervals without restart
4. **Feature Flags**: Enable/disable features across deployments
5. **Secrets Management**: Securely distribute sensitive configuration

## Current State

BRI currently supports configuration only through:
- Constructor options passed to `createDB()`
- Environment variables (`BRI_DATA_DIR`, `BRI_MAX_MEMORY_MB`)
- Static defaults in `storage/interface.js`

No remote configuration capability exists.

## Proposed Architecture

### 1. Configuration Hierarchy

```
Priority (highest to lowest):
1. Runtime overrides (programmatic)
2. Environment variables
3. Remote configuration server
4. Local config file (config.jss)
5. Built-in defaults
```

### 2. Remote Config Protocol

**Supported Backends**:
- HTTP/HTTPS REST endpoint
- etcd
- Consul
- AWS Parameter Store / Secrets Manager
- Environment-specific JSON files (S3, GCS)

### 3. Configuration Schema

```javascript
{
  version: "1.0",
  instanceId: "bri-prod-us-east-1",
  environment: "production",

  // Core settings
  storage: {
    dataDir: "/var/lib/bri/data",
    maxMemoryMB: 512,
    evictionThreshold: 0.85,
    walSegmentSize: 20971520,  // 20MB
    fsyncMode: "batched",
    fsyncIntervalMs: 50,
    snapshotIntervalMs: 1800000
  },

  // Archive settings (from del spec)
  archive: {
    enabled: true,
    retentionDays: 90,
    maxSizeMB: 2048
  },

  // Remote endpoints
  remoteArchive: {
    endpoint: "s3://bucket/archive",
    credentials: "${AWS_CREDENTIALS}"  // Reference to secrets
  },

  // Feature flags
  features: {
    enableTransactions: true,
    enableSubscriptions: true,
    enableColdTier: true,
    enableCompression: false
  },

  // Operational settings
  operations: {
    maxConcurrentReads: 100,
    maxConcurrentWrites: 50,
    queryTimeout: 30000,
    connectionPoolSize: 10
  },

  // Monitoring
  telemetry: {
    enabled: true,
    endpoint: "https://metrics.example.com/v1/ingest",
    intervalMs: 60000,
    includeQueryStats: true
  },

  // Security
  security: {
    encryptAtRest: true,
    encryptionKeyRef: "vault:secret/bri/encryption-key",
    auditLog: true
  },

  // Last updated metadata
  _meta: {
    lastModified: "2024-01-15T10:30:00Z",
    modifiedBy: "admin@example.com",
    configVersion: 42,
    checksum: "sha256:abc123..."
  }
}
```

### 4. Remote Config Client

**File**: `config/remote-client.js`

```javascript
export class RemoteConfigClient {
  constructor(options) {
    this.provider = options.provider;  // 'http', 'etcd', 'consul', 's3'
    this.endpoint = options.endpoint;
    this.refreshIntervalMs = options.refreshIntervalMs || 300000; // 5 min
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelayMs = options.retryDelayMs || 1000;
    this.timeout = options.timeout || 10000;

    this.currentConfig = null;
    this.configVersion = 0;
    this.lastFetch = null;
    this.refreshTimer = null;
  }

  // Fetch configuration from remote
  async fetch() { }

  // Start periodic refresh
  startRefresh(onChange) { }

  // Stop refresh
  stopRefresh() { }

  // Validate config against schema
  validate(config) { }

  // Resolve secret references (${VAR}, vault:path, etc.)
  async resolveSecrets(config) { }

  // Get specific config value with dot notation
  get(path, defaultValue) { }

  // Check if config has changed
  hasChanged(newConfig) { }
}
```

### 5. Provider Implementations

#### HTTP Provider
```javascript
// config/providers/http.js
export class HttpConfigProvider {
  async fetch(endpoint, options) {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${options.token}`,
        'X-Instance-ID': options.instanceId,
        'Accept': 'application/json'
      },
      timeout: options.timeout
    });

    if (!response.ok) {
      throw new ConfigFetchError(response.status, await response.text());
    }

    return response.json();
  }

  // Long-polling for changes
  async watch(endpoint, options, onChange) {
    // Server returns when config changes or timeout
  }
}
```

#### etcd Provider
```javascript
// config/providers/etcd.js
export class EtcdConfigProvider {
  constructor(hosts) {
    this.client = new Etcd3({ hosts });
  }

  async fetch(key) {
    const value = await this.client.get(key).string();
    return JSON.parse(value);
  }

  async watch(key, onChange) {
    const watcher = await this.client.watch().key(key).create();
    watcher.on('put', (res) => onChange(JSON.parse(res.value.toString())));
  }
}
```

#### Consul Provider
```javascript
// config/providers/consul.js
export class ConsulConfigProvider {
  async fetch(key) {
    const response = await fetch(
      `${this.endpoint}/v1/kv/${key}?raw=true`
    );
    return response.json();
  }

  async watch(key, onChange) {
    // Consul blocking queries with index
  }
}
```

### 6. Configuration Manager

**File**: `config/manager.js`

```javascript
export class ConfigManager {
  constructor(options = {}) {
    this.localConfig = {};
    this.remoteConfig = {};
    this.effectiveConfig = {};
    this.remoteClient = null;
    this.changeHandlers = [];
    this.schema = CONFIG_SCHEMA;
  }

  // Initialize with optional remote source
  async initialize(options) {
    // 1. Load local config file if exists
    await this.loadLocalConfig();

    // 2. Load environment variables
    this.loadEnvConfig();

    // 3. Connect to remote if configured
    if (options.remote) {
      this.remoteClient = new RemoteConfigClient(options.remote);
      await this.fetchRemoteConfig();
      this.remoteClient.startRefresh(this.onRemoteChange.bind(this));
    }

    // 4. Merge and validate
    this.mergeConfigs();
    this.validate();

    return this.effectiveConfig;
  }

  // Get config value
  get(path, defaultValue) {
    return _.get(this.effectiveConfig, path, defaultValue);
  }

  // Runtime override (highest priority)
  set(path, value) {
    _.set(this.localConfig, path, value);
    this.mergeConfigs();
    this.notifyChange(path, value);
  }

  // Register change handler
  onChange(handler) {
    this.changeHandlers.push(handler);
    return () => this.changeHandlers = this.changeHandlers.filter(h => h !== handler);
  }

  // Handle remote config update
  onRemoteChange(newConfig) {
    const changes = this.detectChanges(this.remoteConfig, newConfig);
    this.remoteConfig = newConfig;
    this.mergeConfigs();

    for (const change of changes) {
      this.notifyChange(change.path, change.newValue, change.oldValue);
    }
  }

  // Hot-reloadable settings
  isHotReloadable(path) {
    const hotReloadPaths = [
      'storage.maxMemoryMB',
      'storage.evictionThreshold',
      'operations.maxConcurrentReads',
      'operations.maxConcurrentWrites',
      'telemetry.*',
      'features.*'
    ];
    return hotReloadPaths.some(p => minimatch(path, p));
  }
}
```

### 7. Integration with BRI

**Modified `client/index.js`**:

```javascript
export async function createDB(options = {}) {
  // Initialize config manager
  const configManager = new ConfigManager();

  await configManager.initialize({
    local: options.configFile || './config.jss',
    remote: options.remoteConfig,  // New option
    env: true
  });

  // Use effective config
  const storeConfig = configManager.get('storage');

  const store = await createStore({
    type: options.storeType || 'inhouse',
    config: storeConfig
  });

  // Watch for config changes
  configManager.onChange((path, newValue, oldValue) => {
    if (path.startsWith('storage.')) {
      store.updateConfig(path.replace('storage.', ''), newValue);
    }
  });

  const engine = createEngine(store);
  const db = createDBInterface(engine, store);

  // Expose config manager
  db.config = configManager;

  return db;
}
```

### 8. Usage Examples

#### Basic Remote Config
```javascript
const db = await createDB({
  remoteConfig: {
    provider: 'http',
    endpoint: 'https://config.example.com/bri/production',
    token: process.env.CONFIG_TOKEN,
    refreshIntervalMs: 60000
  }
});
```

#### etcd Configuration
```javascript
const db = await createDB({
  remoteConfig: {
    provider: 'etcd',
    hosts: ['http://etcd1:2379', 'http://etcd2:2379'],
    key: '/config/bri/production',
    watch: true
  }
});
```

#### With Local Overrides
```javascript
const db = await createDB({
  remoteConfig: {
    provider: 'http',
    endpoint: 'https://config.example.com/bri/production'
  },
  // Local overrides take precedence
  storeConfig: {
    maxMemoryMB: 1024  // Override remote value
  }
});
```

#### Runtime Config Updates
```javascript
// Check current config
console.log(db.config.get('storage.maxMemoryMB'));

// Update at runtime (if hot-reloadable)
db.config.set('storage.maxMemoryMB', 512);

// Listen for changes
db.config.onChange((path, newValue, oldValue) => {
  console.log(`Config changed: ${path} = ${newValue} (was ${oldValue})`);
});
```

### 9. Secret Resolution

Support for secure secret references:

```javascript
{
  "security": {
    // Environment variable
    "apiKey": "${API_KEY}",

    // HashiCorp Vault
    "encryptionKey": "vault:secret/data/bri/keys#encryption",

    // AWS Secrets Manager
    "dbPassword": "aws-sm:bri/database-credentials#password",

    // AWS Parameter Store
    "configValue": "aws-ssm:/bri/production/config-value",

    // File reference
    "certificate": "file:/etc/ssl/certs/bri.crt"
  }
}
```

**Secret Resolver**:
```javascript
// config/secrets.js
export class SecretResolver {
  constructor() {
    this.resolvers = {
      'env': this.resolveEnv,
      'vault': this.resolveVault,
      'aws-sm': this.resolveAWSSecretsManager,
      'aws-ssm': this.resolveAWSParameterStore,
      'file': this.resolveFile
    };
  }

  async resolve(value) {
    if (typeof value !== 'string') return value;

    // ${ENV_VAR} pattern
    if (value.startsWith('${') && value.endsWith('}')) {
      return this.resolveEnv(value.slice(2, -1));
    }

    // provider:path pattern
    const match = value.match(/^([\w-]+):(.+)$/);
    if (match && this.resolvers[match[1]]) {
      return this.resolvers[match[1]](match[2]);
    }

    return value;
  }
}
```

### 10. Config Server Implementation (Optional)

A simple config server for self-hosted deployments:

```javascript
// config-server/index.js
import { serve } from 'bun';

const configs = new Map();

serve({
  port: 8080,

  async fetch(req) {
    const url = new URL(req.url);
    const instanceId = req.headers.get('X-Instance-ID');

    if (req.method === 'GET' && url.pathname.startsWith('/config/')) {
      const key = url.pathname.replace('/config/', '');
      const config = configs.get(key);

      if (!config) {
        return new Response('Not Found', { status: 404 });
      }

      return Response.json(config);
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/config/')) {
      const key = url.pathname.replace('/config/', '');
      const config = await req.json();
      configs.set(key, {
        ...config,
        _meta: {
          lastModified: new Date().toISOString(),
          configVersion: (configs.get(key)?._meta?.configVersion || 0) + 1
        }
      });

      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }
});
```

### 11. Configuration Validation

**Schema Definition**:
```javascript
// config/schema.js
export const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    storage: {
      type: 'object',
      properties: {
        dataDir: { type: 'string', default: './data' },
        maxMemoryMB: { type: 'number', minimum: 16, default: 256 },
        evictionThreshold: { type: 'number', minimum: 0.5, maximum: 1.0, default: 0.8 },
        walSegmentSize: { type: 'number', minimum: 1048576, default: 10485760 },
        fsyncMode: { type: 'string', enum: ['always', 'batched', 'os'], default: 'batched' },
        fsyncIntervalMs: { type: 'number', minimum: 10, default: 100 },
        snapshotIntervalMs: { type: 'number', minimum: 60000, default: 1800000 }
      },
      required: ['maxMemoryMB']
    },
    features: {
      type: 'object',
      properties: {
        enableTransactions: { type: 'boolean', default: true },
        enableSubscriptions: { type: 'boolean', default: true },
        enableColdTier: { type: 'boolean', default: true }
      }
    }
    // ... more schema definitions
  }
};
```

### 12. Error Handling

```javascript
// config/errors.js
export class ConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class ConfigFetchError extends ConfigError {
  constructor(status, body) {
    super(`Failed to fetch config: ${status}`, 'FETCH_ERROR');
    this.status = status;
    this.body = body;
  }
}

export class ConfigValidationError extends ConfigError {
  constructor(errors) {
    super(`Config validation failed: ${errors.join(', ')}`, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}

export class SecretResolutionError extends ConfigError {
  constructor(secretRef, cause) {
    super(`Failed to resolve secret: ${secretRef}`, 'SECRET_ERROR');
    this.secretRef = secretRef;
    this.cause = cause;
  }
}
```

### 13. Startup Behavior

```javascript
// Startup with remote config
async function startWithRemoteConfig() {
  try {
    const db = await createDB({
      remoteConfig: {
        provider: 'http',
        endpoint: configEndpoint,
        // Startup behavior
        required: true,           // Fail if can't fetch
        startupTimeout: 30000,    // Wait up to 30s for config
        fallbackToLocal: true,    // Use local config if remote fails
        cacheLocally: true        // Cache remote config locally
      }
    });
  } catch (error) {
    if (error instanceof ConfigFetchError) {
      console.error('Failed to fetch remote config, using defaults');
      // Optionally start with defaults
    }
    throw error;
  }
}
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `config/manager.js` | Create | Main config manager |
| `config/remote-client.js` | Create | Remote config fetching |
| `config/providers/http.js` | Create | HTTP provider |
| `config/providers/etcd.js` | Create | etcd provider |
| `config/providers/consul.js` | Create | Consul provider |
| `config/secrets.js` | Create | Secret resolution |
| `config/schema.js` | Create | Config validation schema |
| `config/errors.js` | Create | Config-specific errors |
| `config/index.js` | Create | Config module exports |
| `client/index.js` | Modify | Integrate config manager |
| `storage/interface.js` | Modify | Support hot-reload |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BRI_CONFIG_PROVIDER` | Remote config provider type | none |
| `BRI_CONFIG_ENDPOINT` | Remote config endpoint URL | none |
| `BRI_CONFIG_TOKEN` | Auth token for config server | none |
| `BRI_CONFIG_REFRESH_MS` | Config refresh interval | 300000 |
| `BRI_CONFIG_FILE` | Local config file path | ./config.jss |
