# Diff Source

Core implementation modules for object change tracking and path operations.

## Overview

These modules provide the underlying functionality for the diff utilities. Each module handles a specific concern:

- **symbols.js** - Shared symbols for marking special values
- **traverse.js** - Object/array flattening and type checking
- **path.js** - Array-based path navigation and comparison
- **match.js** - Object equality and partial matching
- **apply.js** - Applying change tuples to objects
- **watch.js** - Proxy-based change tracking
