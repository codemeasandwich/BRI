# Tests

Comprehensive test suite for BRI database.

## Overview

End-to-end tests covering all major functionality including CRUD operations, persistence, transactions, middleware, and edge cases.

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- tests/e2e/crud.test.js

# Run in watch mode
npm test -- --watch
```

## Test Structure

```
tests/
└── e2e/                    # End-to-end integration tests
    ├── crud.test.js        # Basic CRUD operations
    ├── persistence.test.js # WAL and snapshot recovery
    ├── transactions.test.js# Transaction commit/rollback
    ├── middleware.test.js  # Middleware plugin system
    ├── reactive.test.js    # Proxy change tracking
    ├── pubsub.test.js      # Subscription notifications
    ├── schema.test.js      # Schema validation
    ├── jss.test.js         # JSS serialization
    ├── diff.test.js        # Change tracking utilities
    ├── sets.test.js        # Collection operations
    ├── edge-cases.test.js  # Boundary conditions
    ├── errors.test.js      # Error handling
    ├── memory.test.js      # Memory management
    └── coverage-gaps.test.js# Additional coverage
```

## Coverage Thresholds

Jest is configured with minimum coverage thresholds:
- Branches: 80%
- Functions: 80%
- Lines: 80%
- Statements: 80%
