## Directory Structure

```
cold-tier/
└── files.js
```

## Files

### `files.js`

Cold tier file storage implementation.

**Class: ColdTierFiles**
- `writeDoc(key, value)` - Write document to type directory
- `readDoc(key)` - Read document from file
- `deleteDoc(key)` - Remove document file
- `docExists(key)` - Check if document exists
- `listDocs()` - List all cold documents
- `getStats()` - Get document count and total size

**Helper Methods:**
- `extractType(key)` - Get type prefix from key
- `extractId(key)` - Get ID suffix from key
- `getDocPath(key)` - Build file path for document
