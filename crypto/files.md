## Directory Structure

```
crypto/
├── index.js
├── aes-gcm.js
├── errors.js
├── key-manager.js
└── providers/
    ├── index.js
    ├── env.js
    ├── file.js
    └── remote.js
```

## Files

### `index.js`

Module exports aggregating all crypto functionality.

**Exports:**
- `encrypt`, `decrypt`, `IV_SIZE`, `TAG_SIZE`, `KEY_SIZE` - from aes-gcm.js
- `KeyManager` - from key-manager.js
- `EncryptionError`, `KeyUnavailableError`, `KeyServiceUnavailableError`, `InvalidKeyError`, `DecryptionError`, `AuthenticationError`, `InsecureKeyFileError` - from errors.js
- `EnvKeyProvider`, `FileKeyProvider`, `RemoteKeyProvider` - from providers/index.js

### `aes-gcm.js`

AES-256-GCM encryption and decryption implementation.

**Exports:**
- `encrypt(plaintext, key, aad)` - Encrypt data, returns IV + AuthTag + Ciphertext
- `decrypt(encryptedData, key, aad)` - Decrypt data, validates authentication tag
- `IV_SIZE` - IV length constant (12 bytes)
- `TAG_SIZE` - Auth tag length constant (16 bytes)
- `KEY_SIZE` - Key length constant (32 bytes)

### `errors.js`

Encryption-specific error hierarchy.

**Exports:**
- `EncryptionError` - Base encryption error
- `KeyUnavailableError` - Key cannot be accessed
- `KeyServiceUnavailableError` - Remote key service unreachable
- `InvalidKeyError` - Key format or length invalid
- `DecryptionError` - Decryption failed (base class)
- `AuthenticationError` - Data tampered or wrong key
- `InsecureKeyFileError` - Key file has insecure permissions

### `key-manager.js`

Key lifecycle management with pluggable providers.

**Class: KeyManager**
- `constructor({ keyProvider, keyProviderConfig, keyRefreshIntervalMs })` - Configure manager
- `initialize()` - Load initial key, fails fast if unavailable
- `getKey()` - Get current 32-byte encryption key
- `getKeyId()` - Get current key identifier
- `close()` - Stop refresh, securely clear key from memory
