## Directory Structure

```
examples/
├── helpers.js
├── 01-crud.js
├── 02-arrays-update.js
├── 03-delete-relations.js
├── 04-populate-subs.js
├── 05-transactions.js
├── 06-advanced.js
└── index.js
```

## Files

### `helpers.js`

Console output formatting helpers for example display.

**Exports:**
- `section(num, title)` - Print numbered section header
- `subsection(title)` - Print subsection header
- `printBanner()` - Print kitchen sink banner
- `printComplete()` - Print completion banner
- `printCleanup()` - Print cleanup section header

### `01-crud.js`

Examples 1-5: CREATE, READ single/all, FILTER with objects and functions.

**Exports:**
- `runCrudExamples(db)` - Run CRUD and filtering examples

### `02-arrays-update.js`

Examples 6-8: Get by array of IDs, UPDATE patterns, REPLACE patterns.

**Exports:**
- `runArrayUpdateExamples(db, entities)` - Run array and update examples

### `03-delete-relations.js`

Examples 9-11: DELETE soft delete, RELATIONSHIPS, POPULATION with .and.

**Exports:**
- `runDeleteRelationExamples(db, entities)` - Run delete and relationship examples

### `04-populate-subs.js`

Examples 12-13: POPULATION with .populate(), SUBSCRIPTIONS.

**Exports:**
- `runPopulateSubsExamples(db, relEntities)` - Run population and subscription examples

### `05-transactions.js`

Examples 14-17: Transactions - commit, rollback, undo, status.

**Exports:**
- `runTransactionExamples(db)` - Run transaction examples

### `06-advanced.js`

Examples 18-20: Entity methods, special types, practical patterns.

**Exports:**
- `runAdvancedExamples(db, entities)` - Run advanced feature examples

### `index.js`

Main entry point that runs all examples in sequence.

**Usage:**
```bash
bun docker/examples/index.js
```
