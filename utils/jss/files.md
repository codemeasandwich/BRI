## Directory Structure

```
jss/
└── index.js
```

## Files

### `index.js`

Main JSS module providing extended JSON serialization.

**Exports:**
- `stringify(obj)` - Serialize object to JSS string
- `parse(str)` - Deserialize JSS string to object
- `encode(obj)` - Convert object to JSS-tagged format
- `decode(data)` - Convert JSS-tagged format to object

**Type Tags:**
- `D` - Date (stored as timestamp)
- `R` - RegExp (stored as string)
- `E` - Error (stored as [name, message, stack])
- `U` - undefined
- `M` - Map (stored as object)
- `S` - Set (stored as array)
- `P` - Pointer (circular reference path)
