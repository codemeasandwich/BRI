# Key Providers

Pluggable key sources for encryption key management.

## Overview

Key providers abstract how encryption keys are obtained. All providers implement the same interface:

```javascript
class KeyProvider {
  async fetchKey() {
    return {
      keyId: string,       // Key identifier
      key: Buffer,         // 32-byte encryption key
      expiresAt: Date|null // Optional expiration
    };
  }
  async close() { }
}
```

## EnvKeyProvider

Reads key from an environment variable. Simplest option for development.

```javascript
const config = {
  keyProvider: 'env',
  keyProviderConfig: {
    envVar: 'BRI_ENCRYPTION_KEY'  // default
  }
};
```

**Key Format:** 64 hex characters (32 bytes)

```bash
export BRI_ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
```

## FileKeyProvider

Reads key from a local file with permission validation.

```javascript
const config = {
  keyProvider: 'file',
  keyProviderConfig: {
    keyPath: '/etc/bri/encryption.key',  // default
    checkPermissions: true               // default
  }
};
```

**Key Format:** Either raw binary (32 bytes) or hex-encoded (64 characters)

**Permissions:** File must have mode `0600` or stricter (owner-only access). Throws `InsecureKeyFileError` if group or other access bits are set.

```bash
# Create key file
openssl rand -hex 32 > /etc/bri/encryption.key
chmod 600 /etc/bri/encryption.key
```

## RemoteKeyProvider

Fetches key from an external HTTPS service. For centralized key management.

```javascript
const config = {
  keyProvider: 'remote',
  keyProviderConfig: {
    endpoint: 'https://keys.example.com',  // Required
    authToken: 'bearer-token',             // Optional
    timeout: 10000,                        // ms, default 10s
    retryAttempts: 3,                      // default
    retryDelayMs: 1000,                    // default
    mtls: {                                // Optional mTLS
      cert: fs.readFileSync('client.crt'),
      key: fs.readFileSync('client.key'),
      ca: fs.readFileSync('ca.crt')
    }
  }
};
```

**Request:** `GET {endpoint}/keys/{keyId}`

**Response Format:**
```json
{
  "key": "base64-encoded-32-bytes",
  "keyId": "key-identifier",
  "expiresAt": "2024-12-31T23:59:59Z"
}
```

**Features:**
- Automatic retry with exponential backoff
- Bearer token authentication
- mTLS for mutual authentication
- Fails fast if service unavailable (no fallback)
