/**
 * E2E Schema Validation Tests
 * Tests: validate, type checks, required, enum, nested
 */

import validate, { checkType } from '../../utils/schema/index.js';

describe('Schema Validation', () => {
  describe('Required Fields', () => {
    test('missing required field returns error', () => {
      const schema = {
        name: { type: String, required: true }
      };
      const result = validate(schema, {});
      expect(result).not.toBeNull();
      expect(result).toContain('name');
    });

    test('present required field passes', () => {
      const schema = {
        name: { type: String, required: true }
      };
      const result = validate(schema, { name: 'Alice' });
      expect(result).toBeNull();
    });

    test('optional field can be missing', () => {
      const schema = {
        name: { type: String, required: false }
      };
      const result = validate(schema, {});
      expect(result).toBeNull();
    });

    test('default required is true', () => {
      const schema = {
        name: { type: String } // No required specified
      };
      const result = validate(schema, {});
      expect(result).not.toBeNull();
    });
  });

  describe('Type: String', () => {
    test('valid string passes', () => {
      const schema = { name: { type: String } };
      const result = validate(schema, { name: 'test' });
      expect(result).toBeNull();
    });

    test('empty string passes', () => {
      const schema = { name: { type: String } };
      const result = validate(schema, { name: '' });
      expect(result).toBeNull();
    });

    test('number fails String type', () => {
      const schema = { name: { type: String } };
      const result = validate(schema, { name: 123 });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: Number', () => {
    test('valid number passes', () => {
      const schema = { count: { type: Number } };
      const result = validate(schema, { count: 42 });
      expect(result).toBeNull();
    });

    test('zero passes', () => {
      const schema = { count: { type: Number } };
      const result = validate(schema, { count: 0 });
      expect(result).toBeNull();
    });

    test('float passes', () => {
      const schema = { value: { type: Number } };
      const result = validate(schema, { value: 3.14 });
      expect(result).toBeNull();
    });

    test('string fails Number type', () => {
      const schema = { count: { type: Number } };
      const result = validate(schema, { count: '42' });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: Boolean', () => {
    test('true passes', () => {
      const schema = { active: { type: Boolean } };
      const result = validate(schema, { active: true });
      expect(result).toBeNull();
    });

    test('false passes', () => {
      const schema = { active: { type: Boolean } };
      const result = validate(schema, { active: false });
      expect(result).toBeNull();
    });

    test('truthy string fails', () => {
      const schema = { active: { type: Boolean } };
      const result = validate(schema, { active: 'true' });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: Date', () => {
    test('Date object passes', () => {
      const schema = { created: { type: Date } };
      const result = validate(schema, { created: new Date() });
      expect(result).toBeNull();
    });

    test('string fails Date type', () => {
      const schema = { created: { type: Date } };
      const result = validate(schema, { created: '2023-01-01' });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: Object', () => {
    test('plain object passes', () => {
      const schema = { data: { type: Object } };
      const result = validate(schema, { data: { key: 'value' } });
      expect(result).toBeNull();
    });

    test('empty object passes', () => {
      const schema = { data: { type: Object } };
      const result = validate(schema, { data: {} });
      expect(result).toBeNull();
    });

    test('array fails Object type', () => {
      const schema = { data: { type: Object } };
      const result = validate(schema, { data: [] });
      expect(result).not.toBeNull();
    });

    test('null fails Object type', () => {
      const schema = { data: { type: Object } };
      const result = validate(schema, { data: null });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: Array', () => {
    test('array passes', () => {
      const schema = { items: { type: Array } };
      const result = validate(schema, { items: [1, 2, 3] });
      expect(result).toBeNull();
    });

    test('empty array passes', () => {
      const schema = { items: { type: Array } };
      const result = validate(schema, { items: [] });
      expect(result).toBeNull();
    });

    test('object fails Array type', () => {
      const schema = { items: { type: Array } };
      const result = validate(schema, { items: {} });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: email', () => {
    test('valid email passes', () => {
      const schema = { email: { type: 'email' } };
      const result = validate(schema, { email: 'test@example.com' });
      expect(result).toBeNull();
    });

    test('invalid email fails', () => {
      const schema = { email: { type: 'email' } };
      const result = validate(schema, { email: 'not-an-email' });
      expect(result).not.toBeNull();
    });

    test('non-string fails email', () => {
      const schema = { email: { type: 'email' } };
      const result = validate(schema, { email: 123 });
      expect(result).not.toBeNull();
    });
  });

  describe('Type: ref', () => {
    test('string reference passes', () => {
      const schema = { author: { type: 'ref' } };
      const result = validate(schema, { author: 'USER_abc123' });
      expect(result).toBeNull();
    });

    test('non-string fails ref', () => {
      const schema = { author: { type: 'ref' } };
      const result = validate(schema, { author: 123 });
      expect(result).not.toBeNull();
    });
  });

  describe('Enum Validation', () => {
    test('valid enum value passes', () => {
      const schema = {
        status: { type: String, enum: ['active', 'inactive', 'pending'] }
      };
      const result = validate(schema, { status: 'active' });
      expect(result).toBeNull();
    });

    test('invalid enum value fails', () => {
      const schema = {
        status: { type: String, enum: ['active', 'inactive'] }
      };
      const result = validate(schema, { status: 'unknown' });
      expect(result).not.toBeNull();
    });
  });

  describe('Getter/Setter Transformations', () => {
    test('getter transforms value', () => {
      const schema = {
        name: {
          type: String,
          get: (v) => v.toUpperCase()
        }
      };
      const obj = { name: 'alice' };
      validate(schema, obj);
      expect(obj.name).toBe('ALICE');
    });

    test('setter transforms value', () => {
      const schema = {
        name: {
          type: String,
          set: (v) => v.trim()
        }
      };
      const obj = { name: '  spaced  ' };
      validate(schema, obj);
      expect(obj.name).toBe('spaced');
    });

    test('getter and setter chain', () => {
      const schema = {
        code: {
          type: String,
          get: (v) => v.toUpperCase(),
          set: (v) => v.slice(0, 4)
        }
      };
      const obj = { code: 'abcdefgh' };
      validate(schema, obj);
      expect(obj.code).toBe('ABCD');
    });
  });

  describe('Nested Object Validation', () => {
    test('validates nested object properties', () => {
      const schema = {
        profile: {
          type: Object,
          properties: {
            name: { type: String },
            age: { type: Number }
          }
        }
      };
      const obj = { profile: { name: 'Alice', age: 30 } };
      const result = validate(schema, obj);
      expect(result).toBeNull();
    });

    test('fails on invalid nested property', () => {
      const schema = {
        profile: {
          type: Object,
          properties: {
            name: { type: String },
            age: { type: Number }
          }
        }
      };
      const obj = { profile: { name: 'Alice', age: 'thirty' } };
      const result = validate(schema, obj);
      expect(result).not.toBeNull();
    });

    test('nested required fields', () => {
      const schema = {
        profile: {
          type: Object,
          properties: {
            name: { type: String, required: true }
          }
        }
      };
      const obj = { profile: {} };
      const result = validate(schema, obj);
      expect(result).not.toBeNull();
    });
  });

  describe('Array Items Validation', () => {
    test('validates array item types', () => {
      // items should be the type directly, not { type: ... }
      const schema = {
        tags: {
          type: Array,
          items: String
        }
      };
      const obj = { tags: ['a', 'b', 'c'] };
      const result = validate(schema, obj);
      expect(result).toBeNull();
    });

    test('fails on invalid array item', () => {
      const schema = {
        numbers: {
          type: Array,
          items: Number
        }
      };
      const obj = { numbers: [1, 2, 'three'] };
      const result = validate(schema, obj);
      expect(result).not.toBeNull();
    });

    test('validates number array', () => {
      const schema = {
        values: {
          type: Array,
          items: Number
        }
      };
      const obj = { values: [1, 2, 3] };
      const result = validate(schema, obj);
      expect(result).toBeNull();
    });

    test('validates boolean array', () => {
      const schema = {
        flags: {
          type: Array,
          items: Boolean
        }
      };
      const obj = { flags: [true, false, true] };
      const result = validate(schema, obj);
      expect(result).toBeNull();
    });
  });

  describe('Multiple Fields', () => {
    test('validates multiple fields', () => {
      const schema = {
        name: { type: String },
        age: { type: Number },
        active: { type: Boolean }
      };
      const obj = { name: 'Test', age: 25, active: true };
      const result = validate(schema, obj);
      expect(result).toBeNull();
    });

    test('fails on first invalid field', () => {
      const schema = {
        name: { type: String },
        age: { type: Number }
      };
      const obj = { name: 123, age: 'twenty' };
      const result = validate(schema, obj);
      expect(result).not.toBeNull();
    });
  });

  describe('Unknown Type', () => {
    test('unknown type fails validation', () => {
      const schema = {
        field: { type: 'unknown' }
      };
      const obj = { field: 'value' };
      const result = validate(schema, obj);
      expect(result).not.toBeNull();
    });
  });
});
