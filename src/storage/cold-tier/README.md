# Cold Tier

JSON file-based storage for overflow documents.

## Overview

The cold tier stores documents that have been evicted from the hot tier due to memory pressure. Documents are organized by type in a directory structure.

## Structure

```
data/cold/
├── POST/
│   ├── fu352dp.jss
│   └── ab123cd.jss
├── USER/
│   └── xy789ef.jss
└── ...
```

## Usage

```javascript
import { ColdTierFiles } from './cold-tier/files.js';

const cold = new ColdTierFiles('./data');

await cold.writeDoc('POST_fu352dp', serializedData);
const data = await cold.readDoc('POST_fu352dp');
```

## Features

- Type-based directory organization
- JSS format for extended type support
- Atomic writes with temp file rename
- Soft-delete key handling (X:key:X)
