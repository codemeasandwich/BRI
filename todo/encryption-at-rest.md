# Encryption at Rest

**Status:** Implemented

## Overview

All data stored on disk is encrypted using AES-256-GCM with configurable key management.

## Encryption Targets

| Component | Location | Strategy |
|-----------|----------|----------|
| WAL | `data/wal/*.wal` | Row-level: encrypt each entry individually |
| Snapshot | `data/snapshot.jss` | File-level: encrypt entire file content |
| Cold Tier | `data/cold/{TYPE}/*.jss` | File-level: encrypt each document file |

## Key Management

### Available Providers

1. **`env`** - Environment variable (default)
   - Key must be 64 hex characters (32 bytes)
   - Set via `BRI_ENCRYPTION_KEY` environment variable

2. **`file`** - Local key file
   - Supports binary (32 bytes) or hex-encoded (64 chars)
   - Checks file permissions (must be 0600 or stricter)
   - Default path: `/etc/bri/encryption.key`

3. **`remote`** - External HTTPS service
   - Fetches key from configurable endpoint
   - Supports mTLS for mutual authentication
   - Retries with exponential backoff
   - **Fails to start** if service unavailable

## Configuration

```javascript
const db = await createDB({
  storeConfig: {
    maxMemoryMB: 256,
    encryption: {
      enabled: true,                    // Enable encryption (default: false)
      algorithm: 'aes-256-gcm',         // Only supported algorithm
      keyProvider: 'env',               // 'env' | 'file' | 'remote'
      keyProviderConfig: {
        // For 'env':
        envVar: 'BRI_ENCRYPTION_KEY',   // Environment variable name

        // For 'file':
        keyPath: '/etc/bri/encryption.key',
        checkPermissions: true,         // Verify 0600 permissions

        // For 'remote':
        endpoint: 'https://keys.example.com/v1',
        authToken: 'bearer-token',
        timeout: 10000,
        retryAttempts: 3,
        mtls: {                         // Optional mTLS
          cert: fs.readFileSync('/path/to/client.crt'),
          key: fs.readFileSync('/path/to/client.key'),
          ca: fs.readFileSync('/path/to/ca.crt')
        }
      },
      keyRefreshIntervalMs: 3600000     // Refresh key every hour (optional)
    }
  }
});
```

## Remote Key Service API Contract

```http
GET /keys/current
Authorization: Bearer {token}

Response:
{
  "keyId": "key-2024-01",
  "key": "base64-encoded-32-bytes",
  "expiresAt": "2024-12-31T..."  // optional
}
```

## Implementation Details

### WAL Encryption Format

```
{timestamp}|{pointer}|{base64(IV + AuthTag + Ciphertext)}
```

- **Timestamp**: Unix timestamp in ms (plaintext for ordering)
- **Pointer**: SHA256 hash for chain integrity (plaintext)
- **Entry**: Encrypted with AAD = `{timestamp}|{pointer}`

### AES-256-GCM Parameters

- Key size: 256 bits (32 bytes)
- IV size: 96 bits (12 bytes, random per operation)
- Auth tag: 128 bits (16 bytes)

### File Locations

```
crypto/
├── index.js              # Module exports
├── aes-gcm.js            # AES-256-GCM encrypt/decrypt
├── key-manager.js        # Key lifecycle management
├── errors.js             # Encryption-specific errors
└── providers/
    ├── index.js
    ├── env.js            # Environment variable provider
    ├── file.js           # Local key file provider
    └── remote.js         # External HTTPS service provider
```

## Security Considerations

1. **Keys never touch disk** - Keys are kept in memory only
2. **Secure key clearing** - Keys are overwritten with random data on shutdown
3. **Fail-fast startup** - Database refuses to start if key unavailable
4. **AAD binding** - WAL entries bind timestamp/pointer to ciphertext
5. **File permissions** - File key provider verifies 0600 permissions

## Testing

Run encryption tests:
```bash
npm test -- tests/e2e/encryption.test.js
```

## Future Enhancements

- [ ] AWS KMS provider
- [ ] HashiCorp Vault provider
- [ ] Key rotation without restart
- [ ] Envelope encryption (DEK/KEK pattern)
