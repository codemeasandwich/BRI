# Engine

Core database engine with CRUD operations and reactivity.

## Overview

The engine provides the data manipulation layer between the client API and storage. It handles ID generation, type management, CRUD operations, and reactive change tracking.

## Usage

```javascript
import { createEngine } from 'bri/engine';

const engine = createEngine(store);

// Create
const user = await engine.create('user', { name: 'Alice' });

// Get by ID
const found = await engine.get('user', 'USER_abc1234');

// Get with filter
const admins = await engine.get('userS', { role: 'admin' });

// Update via reactive proxy
found.name = 'Bob';
await found.save();

// Remove
await engine.remove('user', found.$ID);
```

## Features

- Automatic ID generation (type prefix + Crockford base32)
- Reactive proxy with change tracking
- Query filtering (object match or function)
- Population of nested references
- Middleware plugin system
- Change publishing for subscriptions
