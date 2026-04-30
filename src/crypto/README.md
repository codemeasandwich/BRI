# Crypto

AES-256-GCM encryption for data at rest with pluggable key providers.

## Overview

The crypto module provides authenticated encryption for the storage layer:
- **WAL entries** - Encrypted before write, decrypted on replay
- **Snapshots** - Encrypted for secure backup

Cold tier files don't need separate encryption as they contain compressed WAL data that's already encrypted.

## Usage

```javascript
import { encrypt, decrypt, KeyManager } from './crypto/index.js';

// Direct encryption
const key = Buffer.from('a1b2c3...', 'hex'); // 32 bytes
const plaintext = Buffer.from('secret data');
const encrypted = encrypt(plaintext, key);
const decrypted = decrypt(encrypted, key);

// With Additional Authenticated Data
const aad = Buffer.from('metadata');
const encrypted = encrypt(plaintext, key, aad);
const decrypted = decrypt(encrypted, key, aad); // AAD must match
```

### Key Manager

```javascript
import { KeyManager } from './crypto/index.js';

const keyManager = new KeyManager({
  keyProvider: 'env',           // 'env' | 'file' | 'remote'
  keyProviderConfig: {},        // Provider-specific config
  keyRefreshIntervalMs: 0       // 0 = disabled
});

await keyManager.initialize();  // Fails fast if key unavailable
const key = keyManager.getKey();
await keyManager.close();       // Securely clears key from memory
```

## Configuration

Enable encryption in storage configuration:

```javascript
const config = {
  encryption: {
    enabled: true,
    algorithm: 'aes-256-gcm',
    keyProvider: 'env',
    keyProviderConfig: {},
    keyRefreshIntervalMs: 0
  }
};
```

### Key Providers

| Provider | Config | Description |
|----------|--------|-------------|
| `env` | `{ envVar }` | Read from environment variable (default: `BRI_ENCRYPTION_KEY`) |
| `file` | `{ keyPath }` | Read from file (default: `/etc/bri/encryption.key`) |
| `remote` | `{ endpoint, authToken, mtls }` | Fetch from HTTPS service |

See [providers/README.md](providers/README.md) for detailed provider configuration.

## Encrypted Data Format

```
┌────────────┬────────────┬─────────────┐
│ IV (12B)   │ Tag (16B)  │ Ciphertext  │
└────────────┴────────────┴─────────────┘
```

- **IV** - Random initialization vector (12 bytes)
- **Tag** - Authentication tag (16 bytes)
- **Ciphertext** - Encrypted data

## Features

- AES-256-GCM authenticated encryption
- Random IV per encryption (same plaintext produces different ciphertext)
- Authentication tag detects tampering
- Additional Authenticated Data (AAD) binds encryption to metadata
- Pluggable key providers (environment, file, remote HTTPS)
- Optional key rotation with background refresh
- Secure memory clearing on close
