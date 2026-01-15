## Directory Structure

```
schema/
└── index.js
```

## Files

### `index.js`

Schema validation module.

**Exports:**
- `default validate(schemaObj, pojoObj)` - Validate object against schema, returns error string or null
- `checkType(type, value)` - Check if value matches expected type

**Validation Features:**
- Required field checking (default: required)
- Type validation (String, Number, Boolean, Date, Object, Array, email, ref)
- Enum constraint validation
- Get/set transformers (applied to value in-place)
- Recursive nested object validation
- Array item type validation
