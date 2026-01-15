## Directory Structure

```
pubsub/
└── local.js
```

## Files

### `local.js`

Local EventEmitter-based pub/sub implementation.

**Class: LocalPubSub**
- `publish(channel, message)` - Emit message to channel
- `subscribe(channel, callback)` - Listen for messages on channel
- `unsubscribe(channel, callback)` - Remove listener
- `subscriberCount(channel)` - Get listener count
- `clear()` - Remove all listeners
