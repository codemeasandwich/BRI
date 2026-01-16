# Enum Support

## Overview

Add support for enumerated types (enums) in BRI, providing type-safe constrained values with validation, auto-completion, and clear error messages when invalid values are used.

## Use Cases

1. **Status Fields**: `status: 'active' | 'inactive' | 'pending'`
2. **Roles**: `role: 'admin' | 'user' | 'guest'`
3. **Categories**: `category: 'electronics' | 'clothing' | 'food'`
4. **Priority Levels**: `priority: 'low' | 'medium' | 'high' | 'critical'`
5. **Payment Status**: `paymentStatus: 'pending' | 'completed' | 'failed' | 'refunded'`

## Current State

BRI has no enum support:
- Any string value can be stored in any field
- No validation of constrained values
- No type hints or auto-completion
- TypeScript definitions don't support enums

## Proposed Design

### 1. Enum Definition

**File**: `engine/enum.js`

```javascript
// Define enum type
export function defineEnum(name, values, options = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Enum values must be a non-empty array');
  }

  const enumDef = {
    name,
    values: new Set(values),
    valuesList: values,  // Preserve order
    default: options.default || values[0],
    nullable: options.nullable || false,
    description: options.description || null,

    // Methods
    isValid(value) {
      if (value === null || value === undefined) {
        return this.nullable;
      }
      return this.values.has(value);
    },

    validate(value) {
      if (!this.isValid(value)) {
        throw new EnumValidationError(this.name, value, this.valuesList);
      }
      return value;
    },

    getValues() {
      return [...this.valuesList];
    },

    // For TypeScript generation
    toTypeScript() {
      return `type ${this.name} = ${this.valuesList.map(v => `'${v}'`).join(' | ')};`;
    }
  };

  return enumDef;
}

// Error class
export class EnumValidationError extends Error {
  constructor(enumName, invalidValue, validValues) {
    const message = `Invalid value "${invalidValue}" for enum "${enumName}". ` +
                    `Valid values are: ${validValues.join(', ')}`;
    super(message);
    this.name = 'EnumValidationError';
    this.enumName = enumName;
    this.invalidValue = invalidValue;
    this.validValues = validValues;
  }
}
```

### 2. Schema Definition with Enums

```javascript
// Define enums
const StatusEnum = defineEnum('Status', ['active', 'inactive', 'pending'], {
  default: 'pending',
  description: 'Entity status'
});

const RoleEnum = defineEnum('Role', ['admin', 'moderator', 'user', 'guest'], {
  default: 'user'
});

const PriorityEnum = defineEnum('Priority', ['low', 'medium', 'high', 'critical'], {
  default: 'medium',
  nullable: true
});

// Register enums with database
const db = await createDB({
  storeConfig: { dataDir: './data', maxMemoryMB: 256 },

  schema: {
    enums: {
      Status: StatusEnum,
      Role: RoleEnum,
      Priority: PriorityEnum
    },

    types: {
      user: {
        fields: {
          name: { type: 'string', required: true },
          email: { type: 'string', required: true },
          status: { type: 'enum', enum: 'Status' },
          role: { type: 'enum', enum: 'Role' }
        }
      },
      task: {
        fields: {
          title: { type: 'string', required: true },
          priority: { type: 'enum', enum: 'Priority' },
          status: { type: 'enum', enum: 'Status' }
        }
      }
    }
  }
});
```

### 3. Enum Registry

**File**: `engine/enum-registry.js`

```javascript
export class EnumRegistry {
  constructor() {
    this.enums = new Map();
    this.typeFields = new Map();  // type -> { field -> enumName }
  }

  // Register enum definition
  register(name, enumDef) {
    if (this.enums.has(name)) {
      throw new Error(`Enum "${name}" is already registered`);
    }
    this.enums.set(name, enumDef);
  }

  // Get enum by name
  get(name) {
    const enumDef = this.enums.get(name);
    if (!enumDef) {
      throw new Error(`Enum "${name}" is not registered`);
    }
    return enumDef;
  }

  // Check if enum exists
  has(name) {
    return this.enums.has(name);
  }

  // Associate field with enum for a type
  setFieldEnum(typeName, fieldName, enumName) {
    if (!this.typeFields.has(typeName)) {
      this.typeFields.set(typeName, new Map());
    }
    this.typeFields.get(typeName).set(fieldName, enumName);
  }

  // Get enum for a specific type's field
  getFieldEnum(typeName, fieldName) {
    const typeEnums = this.typeFields.get(typeName);
    if (!typeEnums) return null;

    const enumName = typeEnums.get(fieldName);
    return enumName ? this.get(enumName) : null;
  }

  // Validate data against type schema
  validateData(typeName, data) {
    const typeEnums = this.typeFields.get(typeName);
    if (!typeEnums) return;

    for (const [fieldName, enumName] of typeEnums) {
      if (fieldName in data) {
        const enumDef = this.get(enumName);
        enumDef.validate(data[fieldName]);
      }
    }
  }

  // Get all registered enums
  getAll() {
    return Object.fromEntries(this.enums);
  }

  // Export for TypeScript generation
  toTypeScript() {
    const types = [];
    for (const [name, enumDef] of this.enums) {
      types.push(enumDef.toTypeScript());
    }
    return types.join('\n\n');
  }
}
```

### 4. Integration with Operations

**Modified `engine/operations.js`**:

```javascript
export function createOperations(store, deps) {
  const { genid, publish, enumRegistry } = deps;

  return {
    // Create operation with enum validation
    create: async (type, data, opts) => {
      // Validate enum fields
      if (enumRegistry) {
        enumRegistry.validateData(type, data);
      }

      // Apply defaults for enum fields
      const typeEnums = enumRegistry?.typeFields.get(type);
      if (typeEnums) {
        for (const [fieldName, enumName] of typeEnums) {
          if (!(fieldName in data)) {
            const enumDef = enumRegistry.get(enumName);
            if (enumDef.default !== undefined) {
              data[fieldName] = enumDef.default;
            }
          }
        }
      }

      // Continue with normal create...
      const $ID = await genid(shortType);
      // ...
    },

    // Update operation with enum validation
    update: async (target, changes, opts) => {
      const type = extractType(target.$ID);

      // Validate only changed enum fields
      if (enumRegistry) {
        const typeEnums = enumRegistry.typeFields.get(type);
        if (typeEnums) {
          for (const [fieldName, enumName] of typeEnums) {
            if (fieldName in changes) {
              const enumDef = enumRegistry.get(enumName);
              enumDef.validate(changes[fieldName]);
            }
          }
        }
      }

      // Continue with normal update...
    }
  };
}
```

### 5. Usage Examples

```javascript
// Define enums
const db = await createDB({
  schema: {
    enums: {
      Status: defineEnum('Status', ['active', 'inactive', 'pending']),
      Role: defineEnum('Role', ['admin', 'user', 'guest'])
    },
    types: {
      user: {
        fields: {
          status: { type: 'enum', enum: 'Status' },
          role: { type: 'enum', enum: 'Role' }
        }
      }
    }
  }
});

// Create with valid enum value
const user = await db.add.user({
  name: 'Alice',
  status: 'active',
  role: 'admin'
});

// Create with default (status defaults to 'pending')
const user2 = await db.add.user({
  name: 'Bob',
  role: 'user'
});
console.log(user2.status);  // 'pending'

// This throws EnumValidationError
try {
  await db.add.user({
    name: 'Charlie',
    status: 'invalid'  // Error!
  });
} catch (error) {
  console.log(error.message);
  // Invalid value "invalid" for enum "Status". Valid values are: active, inactive, pending
}

// Update with validation
user.status = 'inactive';  // OK
await user.save();

user.status = 'deleted';  // Throws on save
await user.save();  // EnumValidationError

// Query by enum value
const activeUsers = await db.get.userS({ status: 'active' });

// Get enum values programmatically
const statusValues = db.schema.enums.Status.getValues();
// ['active', 'inactive', 'pending']
```

### 6. Enum with Metadata

```javascript
// Extended enum with metadata
const StatusEnum = defineEnum('Status', [
  { value: 'active', label: 'Active', color: 'green' },
  { value: 'inactive', label: 'Inactive', color: 'gray' },
  { value: 'pending', label: 'Pending Review', color: 'yellow' },
  { value: 'suspended', label: 'Suspended', color: 'red' }
], {
  default: 'pending',
  valueKey: 'value'  // Specify which property holds the actual value
});

// Access metadata
StatusEnum.getMetadata('active');
// { value: 'active', label: 'Active', color: 'green' }

StatusEnum.getLabel('active');  // 'Active'
StatusEnum.getColor('pending');  // 'yellow'
```

### 7. TypeScript Support

**Generated type definitions**:

```typescript
// Auto-generated from schema
export type Status = 'active' | 'inactive' | 'pending';
export type Role = 'admin' | 'moderator' | 'user' | 'guest';
export type Priority = 'low' | 'medium' | 'high' | 'critical' | null;

export interface User {
  $ID: string;
  name: string;
  email: string;
  status: Status;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  $ID: string;
  title: string;
  priority: Priority;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
}

// Enum utilities
export const StatusValues: readonly Status[] = ['active', 'inactive', 'pending'];
export const RoleValues: readonly Role[] = ['admin', 'moderator', 'user', 'guest'];
```

**Generate TypeScript definitions**:

```javascript
// CLI command
bri schema generate-types --output ./types/bri.d.ts

// Or programmatically
const types = db.schema.generateTypeScript();
await fs.writeFile('./types/bri.d.ts', types);
```

### 8. Enum Migrations

When enum values need to change:

```javascript
// Migration: Add new status value
await db.schema.migrateEnum('Status', {
  addValues: ['archived'],
  removeValues: [],
  renameValues: {}
});

// Migration: Rename value (updates all documents)
await db.schema.migrateEnum('Status', {
  renameValues: { 'inactive': 'disabled' }
});

// Migration: Remove value (requires replacement)
await db.schema.migrateEnum('Status', {
  removeValues: ['pending'],
  defaultReplacement: 'active'  // Replace 'pending' with 'active'
});
```

### 9. Enum Validation Modes

```javascript
const db = await createDB({
  schema: {
    enums: { ... },
    types: { ... }
  },

  // Validation modes
  enumValidation: {
    onCreate: 'strict',      // Validate on create (strict/warn/off)
    onUpdate: 'strict',      // Validate on update
    onLoad: 'warn',          // Validate when loading from storage
    unknownValues: 'reject'  // reject/accept/warn for unknown values
  }
});
```

### 10. API Endpoints for Enums

```javascript
// GET /api/_schema/enums
// List all registered enums
app.get('/api/_schema/enums', async (ctx) => {
  const enums = db.schema.enums;
  ctx.json(Object.fromEntries(
    Object.entries(enums).map(([name, def]) => [name, {
      values: def.getValues(),
      default: def.default,
      nullable: def.nullable
    }])
  ));
});

// GET /api/_schema/enums/:name
// Get specific enum
app.get('/api/_schema/enums/:name', async (ctx) => {
  const enumDef = db.schema.enums[ctx.params.name];
  if (!enumDef) {
    ctx.status = 404;
    ctx.json({ error: 'Enum not found' });
    return;
  }
  ctx.json({
    name: enumDef.name,
    values: enumDef.getValues(),
    default: enumDef.default,
    nullable: enumDef.nullable,
    description: enumDef.description
  });
});

// GET /api/_schema/types/:type/fields
// Get type schema including enum constraints
app.get('/api/_schema/types/:type/fields', async (ctx) => {
  const typeSchema = db.schema.types[ctx.params.type];
  ctx.json(typeSchema);
});
```

### 11. Inline Enum Definition

For simple cases without separate enum registration:

```javascript
const db = await createDB({
  schema: {
    types: {
      task: {
        fields: {
          // Inline enum definition
          priority: {
            type: 'enum',
            values: ['low', 'medium', 'high'],
            default: 'medium'
          },
          status: {
            type: 'enum',
            values: ['todo', 'in_progress', 'done'],
            default: 'todo'
          }
        }
      }
    }
  }
});
```

### 12. Enum Helpers

```javascript
// Check if value is valid
db.schema.isValidEnumValue('Status', 'active');  // true
db.schema.isValidEnumValue('Status', 'invalid'); // false

// Get valid values for field
db.schema.getFieldValues('user', 'status');
// ['active', 'inactive', 'pending']

// Get default value
db.schema.getFieldDefault('user', 'status');  // 'pending'

// Validate object against schema
const errors = db.schema.validate('user', {
  name: 'Alice',
  status: 'invalid'
});
// [{ field: 'status', error: 'Invalid enum value', ... }]
```

## Configuration

```javascript
const db = await createDB({
  schema: {
    // Global enum settings
    enumDefaults: {
      nullable: false,
      strict: true  // Throw on invalid vs warn
    },

    enums: {
      Status: defineEnum('Status', ['active', 'inactive', 'pending']),
      // ...
    },

    types: {
      user: {
        fields: {
          status: { type: 'enum', enum: 'Status' }
        }
      }
    }
  }
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `engine/enum.js` | Create | Enum definition and validation |
| `engine/enum-registry.js` | Create | Enum registry management |
| `engine/schema.js` | Create | Schema definition with enums |
| `engine/operations.js` | Modify | Add enum validation |
| `engine/index.js` | Modify | Initialize enum registry |
| `client/index.js` | Modify | Pass schema config |
| `types/index.d.ts` | Modify | Add enum type definitions |

## Error Messages

| Error | Message |
|-------|---------|
| Invalid value | `Invalid value "X" for enum "Status". Valid values are: active, inactive, pending` |
| Unknown enum | `Enum "Unknown" is not registered` |
| Duplicate enum | `Enum "Status" is already registered` |
| Migration conflict | `Cannot remove enum value "pending" - 42 documents use this value` |
