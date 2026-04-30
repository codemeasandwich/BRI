# WAL - Write-Ahead Log

Append-only log for durability and crash recovery.

## Overview

The WAL ensures durability by logging all write operations before applying them. On crash, the WAL can be replayed to recover state.

## Format

Each line: `{timestamp}|{pointer}|{entry}`
- **timestamp** - Unix timestamp in milliseconds
- **pointer** - SHA256 hash linking to previous entry (chain integrity)
- **entry** - JSS-encoded operation data

## Operations

- `SET` - Store key-value pair
- `DELETE` - Remove key
- `RENAME` - Rename key
- `SADD` - Add to set
- `SREM` - Remove from set

## Fsync Modes

- `always` - Fsync after every write (slowest, safest)
- `batched` - Fsync on interval (default, balanced)
- `none` - OS-managed fsync (fastest, least safe)
