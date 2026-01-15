# Schema

Mongoose-like schema validation for BRI documents.

## Overview

This module provides schema validation supporting type checking, required fields, enum constraints, get/set transformers, nested objects, and array item validation.

## Usage

```javascript
import validate from 'bri/utils/schema';

const userSchema = {
  name: { type: String, required: true },
  email: { type: 'email', required: true },
  role: { type: String, enum: ['admin', 'user'], required: false },
  age: { type: Number, required: false }
};

const error = validate(userSchema, userData);
if (error) {
  console.error('Validation failed:', error);
}
```

## Supported Types

- `String`, `Number`, `Boolean`, `Date`, `Object`, `Array`
- `'email'` - String with email format validation
- `'ref'` - Reference ID (string)

## Schema Options

- `type` - Required type constructor or string
- `required` - Boolean (default: true)
- `enum` - Array of allowed values
- `get` - Transform function when reading
- `set` - Transform function when writing
- `properties` - Nested schema for Object type
- `items` - Type for Array elements
