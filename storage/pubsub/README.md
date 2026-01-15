# PubSub

Local publish/subscribe implementation for change notifications.

## Overview

Provides EventEmitter-based pub/sub for single-process use. Used by the engine to notify subscribers of document changes.

## Usage

```javascript
import { LocalPubSub } from './pubsub/local.js';

const pubsub = new LocalPubSub();

await pubsub.subscribe('users', (message) => {
  console.log('User changed:', message);
});

await pubsub.publish('users', JSON.stringify({ id: '123', action: 'update' }));
```
