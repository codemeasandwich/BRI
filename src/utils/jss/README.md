# JSS - JSON SuperSet

Extended JSON serialization with support for JavaScript types not natively supported by JSON.

## Overview

JSS (JSON SuperSet) provides serialize/deserialize functionality that preserves type information for Date, Error, RegExp, Map, Set, undefined, and handles circular references.

## Usage

```javascript
import jss from 'bri/utils/jss';

const data = {
  created: new Date(),
  pattern: /test/gi,
  items: new Set([1, 2, 3]),
  lookup: new Map([['key', 'value']])
};

const encoded = jss.stringify(data);
const decoded = jss.parse(encoded);
```

## Supported Types

- **Date** - Preserved as timestamp
- **RegExp** - Preserved as string pattern with flags
- **Error** - Preserved with name, message, and stack
- **Map** - Converted to/from object entries
- **Set** - Converted to/from array
- **undefined** - Explicitly preserved
- **Circular references** - Handled via path pointers
