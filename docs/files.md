## Directory Structure

```
docs/
├── README.md
├── files.md
└── vector.md
```

## Files

### `README.md`

Index of capability-area documents. Lists each document and its scope so readers can find the right walkthrough quickly.

### `files.md`

This index — explains the responsibility of every file in this directory.

### `vector.md`

End-user walkthrough of the vector-search surface (UC-V1 slice). Covers schema declaration, the chainable `db.get.{collection}S.where(...).near(...)` API, result metadata (`$cosine`, `$score`), error modes, backwards compatibility with the legacy callable form, and v1 limitations with pointers to v2 follow-ups.
