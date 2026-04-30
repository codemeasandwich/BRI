## Directory Structure

```
src/utils/schema/
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
- Type validation (String, Number, Boolean, Date, Object, Array, email, ref, vector)
- Enum constraint validation
- Get/set transformers (applied to value in-place)
- Recursive nested object validation
- Array item type validation
- Vector deep validation (dimensionality, finite-numeric elements)
- Collection-level options ($-prefixed keys like $indexes, $supersession) are skipped during per-document validation — they configure engine behavior, not field shape
- Per-field options like `cascadeOn: '{scope}'` are recognized at schema-registration time (in engine/schema-registry.js) and don't affect document-level validation
