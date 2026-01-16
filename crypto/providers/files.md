## Directory Structure

```
providers/
├── index.js
├── env.js
├── file.js
└── remote.js
```

## Files

### `index.js`

Provider exports aggregating all key providers.

**Exports:**
- `EnvKeyProvider` - from env.js
- `FileKeyProvider` - from file.js
- `RemoteKeyProvider` - from remote.js

### `env.js`

Environment variable key provider.

**Class: EnvKeyProvider**
- `constructor({ envVar })` - Configure env var name (default: `BRI_ENCRYPTION_KEY`)
- `fetchKey()` - Read and validate hex key from environment
- `close()` - No-op

### `file.js`

File-based key provider with permission checks.

**Class: FileKeyProvider**
- `constructor({ keyPath, checkPermissions })` - Configure file path and permission check
- `fetchKey()` - Read key from file (raw binary or hex-encoded)
- `verifyPermissions()` - Validate file has owner-only access (0600)
- `close()` - No-op

### `remote.js`

Remote HTTPS key provider with retry and mTLS support.

**Class: RemoteKeyProvider**
- `constructor({ endpoint, authToken, timeout, retryAttempts, retryDelayMs, mtls })` - Configure service connection
- `fetchKey(keyId)` - Fetch key from remote service with retry
- `close()` - No-op
