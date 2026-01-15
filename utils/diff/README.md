# Diff

Object change tracking and path utilities for reactive data management.

## Overview

This module provides utilities for tracking changes to objects, comparing values, and navigating nested structures using array-based paths.

## Usage

```javascript
import { createChangeTracker, isPartialMatch, getByPath } from 'bri/utils/diff';

// Track changes to an object
const tracked = createChangeTracker(myObject, {
  onSave: (changes) => console.log('Changes:', changes)
});

tracked.name = 'updated';
await tracked.save();

// Check partial match
isPartialMatch({ role: 'admin' }, user); // true if user.role === 'admin'

// Get nested value by path
getByPath(obj, ['users', 0, 'name']); // obj.users[0].name
```

## Features

- Change tracking with Proxy-based observation
- Path-based value access and comparison
- Partial and deep equality matching
- Flatten nested objects to path-value tuples
