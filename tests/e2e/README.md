# E2E Tests

End-to-end integration tests for BRI database.

## Overview

These tests validate the complete BRI system including storage, engine, and client layers working together.

## Test Categories

### Core Functionality
- **crud.test.js** - Create, read, update, delete operations
- **persistence.test.js** - WAL replay and snapshot recovery
- **transactions.test.js** - Transaction commit, rollback, isolation

### Features
- **middleware.test.js** - Plugin system and hooks
- **reactive.test.js** - Proxy-based change tracking
- **pubsub.test.js** - Subscription and notifications
- **schema.test.js** - Schema validation

### Utilities
- **jss.test.js** - JSON SuperSet serialization
- **diff.test.js** - Object change tracking
- **sets.test.js** - Collection index operations

### Edge Cases
- **edge-cases.test.js** - Boundary conditions
- **errors.test.js** - Error handling
- **memory.test.js** - Memory pressure and eviction
- **coverage-gaps.test.js** - Additional coverage paths
