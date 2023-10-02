# Bri: Bigdata Repository of Intelligence

This Bri database provides an easy-to-use interface for performing CRUD (Create, Read, Update, Delete) operations on documents. It also includes additional features such as subscribing to document changes and populating attributes with IDs.

**Note**: All documents, when created, are assigned a unique `$ID` in the form of four capitalized letters, representing the first two and last two characters of the document type name, followed by an underscore and then 7 base 32 characters (in Crockford encoding format). There is also a `createdAt` and `updatedAt` timestamp managed by the database that cannot be modified by the client.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Action Functions](#action-functions)
  - [Document Retrieval Behavior](#document-retrieval-behavior)
  - [Additional Properties for Retrieved Records](#additional-properties-for-retrieved-records)
- [Examples](#examples)
  - [Adding a Document](#adding-a-document)
  - [Retrieving a Document](#retrieving-a-document)
  - [Updating a Document](#updating-a-document)
  - [Deleting a Document](#deleting-a-document)
  - [Subscribing to Changes](#subscribing-to-changes)
  - [Populating Attributes](#populating-attributes)

## Installation

You can install the NoSQL Database Library using npm or other package managers. For npm, run the following command:

```bash
npm install nosql-db-library
```

For Yarn, run:

```bash
yarn add nosql-db-library
```

Make sure to replace `nosql-db-library` with the actual name of the library when it is published.

## Usage

First, you need to import the library in your JavaScript or TypeScript project:

```javascript
const db = require('nosql-db-library');
```

For TypeScript or ECMAScript modules, use:

```javascript
import * as db from 'nosql-db-library';
```

After importing the library, you can use the provided action functions to interact with the database.

### Action Functions

There are five action functions for interacting with the database:

- `sub`: Subscribe to changes in documents.
- `get`: Retrieve a document.
- `add`: Insert a new document.
- `set`: Replace an existing document.
- `del`: Delete a document.

### Document Retrieval Behavior

- If a capital "S" is appended to the action function (e.g., `db.get.fooS()`), all matching documents are returned.
- Otherwise, only the first matching document is returned.

### Additional Properties for Retrieved Records

Retrieved records have two additional properties:

- `save()`: Persist any changes made to the current document.
- `.and.`: Populate an attribute with IDs, e.g., `const userWithPopulatedFriendsList = await user.and.friends()`.

## Examples

### Adding a Document

```javascript
db.add.foo({ a: { b: [1, 2] } }).then((foo) => {
  console.log("foo", foo);
});
```

### Retrieving a Document

```javascript
db.get.foo("<document-id>").then((foo) => {
  console.log("foo", foo);
});
```

### Updating a Document

```javascript
db.get.foo("<document-id>")
  .then((foo) => {
    foo.a.b.push(3);
    return foo.save();
  })
  .then((updatedFoo) => {
    console.log("updatedFoo", updatedFoo);
  });
```

### Deleting a Document

```javascript
db.del.foo("<document-id>").then(() => {
  console.log("Document deleted");
});
```

### Subscribing to Changes

```javascript
db.sub
  .user((x) => console.log("->", x))
  .then((unsub) => {
    // Perform operations here and then unsubscribe
    unsub();
  });
```

### Populating Attributes

```javascript
const userWithPopulatedFriendsList = await user.and.friends();
console.log(userWithPopulatedFriendsList);
```

For more detailed examples and usage scenarios, refer to the provided code snippets in the question.