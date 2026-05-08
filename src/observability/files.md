## Directory Structure

```
src/observability/
└── logger.js
```

## Files

### `logger.js`

Structured runtime logger boundary for Bri. Preserves default standalone
console lifecycle messages, supports `logger: false` for silence, and routes
stable `{event, level, severity, message, metadata, error}` payloads to custom
application loggers.

**Exports:**
- `createBriLogger(config)` - Build a logger from public config.
- `defaultBriLogger` - Safe default logger for low-level helpers.
