/**
 * E2E Schema Validation Tests — typed-error contract
 *
 * The validator was migrated from "return string|null" to "throw
 * BriValidationError" as part of the spec §2.11 typed-error work. These
 * tests exercise the throw contract:
 *   - Valid inputs: validate(...) completes without throwing.
 *   - Invalid inputs: validate(...) throws BriValidationError, with a
 *     stable .code and a diagnostic message.
 *
 * The previous shape (`expect(result).toBeNull()` / `.not.toBeNull()`) is
 * intentionally removed — the new contract is that absence of a throw is
 * success, presence of a typed throw is failure.
 */

import validate, { checkType } from '../../utils/schema/index.js';
import { BriValidationError } from '../../engine/errors.js';

function expectValid(schema, obj) {
  expect(() => validate(schema, obj)).not.toThrow();
}
function expectInvalid(schema, obj, codeMatch) {
  let thrown;
  try { validate(schema, obj); } catch (e) { thrown = e; }
  expect(thrown).toBeInstanceOf(BriValidationError);
  if (codeMatch) {
    if (typeof codeMatch === 'string') expect(thrown.code).toBe(codeMatch);
    else expect(thrown.code).toMatch(codeMatch);
  }
  // Returning would make arrow-bodied test() callers leak a non-promise
  // return into Jest. Stash the thrown error on the function for callers
  // that need to inspect it (use captureInvalid instead).
}
function captureInvalid(schema, obj, codeMatch) {
  let thrown;
  try { validate(schema, obj); } catch (e) { thrown = e; }
  expect(thrown).toBeInstanceOf(BriValidationError);
  if (codeMatch) expect(thrown.code).toBe(codeMatch);
  return thrown;
}

describe('Schema Validation', () => {
  describe('Required Fields', () => {
    test('missing required field throws', () => {
      const e = captureInvalid({ name: { type: String, required: true } }, {}, 'FIELD_REQUIRED');
      expect(e.message).toContain('name');
    });

    test('present required field passes', () => {
      expectValid({ name: { type: String, required: true } }, { name: 'Alice' });
    });

    test('optional field can be missing', () => {
      expectValid({ name: { type: String, required: false } }, {});
    });

    test('default required is true', () => {
      expectInvalid({ name: { type: String } }, {}, 'FIELD_REQUIRED');
    });
  });

  describe('Type: String', () => {
    test('valid string passes', () => expectValid({ name: { type: String } }, { name: 'test' }));
    test('empty string passes', () => expectValid({ name: { type: String } }, { name: '' }));
    test('number fails String type', () =>
      expectInvalid({ name: { type: String } }, { name: 123 }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: Number', () => {
    test('valid number passes', () => expectValid({ count: { type: Number } }, { count: 42 }));
    test('zero passes', () => expectValid({ count: { type: Number } }, { count: 0 }));
    test('float passes', () => expectValid({ value: { type: Number } }, { value: 3.14 }));
    test('string fails Number type', () =>
      expectInvalid({ count: { type: Number } }, { count: '42' }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: Boolean', () => {
    test('true passes', () => expectValid({ active: { type: Boolean } }, { active: true }));
    test('false passes', () => expectValid({ active: { type: Boolean } }, { active: false }));
    test('truthy string fails', () =>
      expectInvalid({ active: { type: Boolean } }, { active: 'true' }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: Date', () => {
    test('Date object passes', () =>
      expectValid({ created: { type: Date } }, { created: new Date() }));
    test('string fails Date type', () =>
      expectInvalid({ created: { type: Date } }, { created: '2023-01-01' }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: Object', () => {
    test('plain object passes', () =>
      expectValid({ data: { type: Object } }, { data: { key: 'value' } }));
    test('empty object passes', () => expectValid({ data: { type: Object } }, { data: {} }));
    test('array fails Object type', () =>
      expectInvalid({ data: { type: Object } }, { data: [] }, 'FIELD_TYPE_MISMATCH'));
    test('null fails Object type', () =>
      expectInvalid({ data: { type: Object } }, { data: null }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: Array', () => {
    test('array passes', () => expectValid({ items: { type: Array } }, { items: [1, 2, 3] }));
    test('empty array passes', () => expectValid({ items: { type: Array } }, { items: [] }));
    test('object fails Array type', () =>
      expectInvalid({ items: { type: Array } }, { items: {} }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: email', () => {
    test('valid email passes', () =>
      expectValid({ email: { type: 'email' } }, { email: 'test@example.com' }));
    test('invalid email fails', () =>
      expectInvalid({ email: { type: 'email' } }, { email: 'not-an-email' }, 'FIELD_TYPE_MISMATCH'));
    test('non-string fails email', () =>
      expectInvalid({ email: { type: 'email' } }, { email: 123 }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: ref', () => {
    test('valid Bri ID passes', () =>
      expectValid({ author: { type: 'ref' } }, { author: 'USER_ab1cdef' }));
    test('non-string fails ref', () =>
      expectInvalid({ author: { type: 'ref' } }, { author: 123 }, 'FIELD_TYPE_MISMATCH'));
    test('malformed ID fails ref with REF_FORMAT_INVALID', () =>
      expectInvalid({ author: { type: 'ref' } }, { author: 'not-an-id' }, 'REF_FORMAT_INVALID'));
  });

  describe('Type: ref|string (polymorphic)', () => {
    test('valid Bri ID passes', () =>
      expectValid({ obj: { type: 'ref|string' } }, { obj: 'KGEN_ab1cdef' }));
    test('plain literal passes', () =>
      expectValid({ obj: { type: 'ref|string' } }, { obj: 'a literal value' }));
    test('empty string fails (must be non-empty)', () =>
      expectInvalid({ obj: { type: 'ref|string' } }, { obj: '' }, 'FIELD_TYPE_MISMATCH'));
    test('id-shaped-but-malformed value fails REF_FORMAT_INVALID', () =>
      expectInvalid({ obj: { type: 'ref|string' } }, { obj: 'KGEN_short' }, 'REF_FORMAT_INVALID'));
  });

  describe('Type: predicate', () => {
    test('non-empty string passes shape check', () =>
      expectValid({ p: { type: 'predicate' } }, { p: 'works_at' }));
    test('empty string fails', () =>
      expectInvalid({ p: { type: 'predicate' } }, { p: '' }, 'FIELD_TYPE_MISMATCH'));
    test('non-string fails', () =>
      expectInvalid({ p: { type: 'predicate' } }, { p: 42 }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Type: vector', () => {
    test('matching dims passes', () =>
      expectValid({ v: { type: 'vector', dims: 3 } }, { v: [0.1, 0.2, 0.3] }));
    test('dim mismatch throws VECTOR_DIMS_MISMATCH', () =>
      expectInvalid({ v: { type: 'vector', dims: 4 } }, { v: [0.1, 0.2] }, 'VECTOR_DIMS_MISMATCH'));
    test('missing dims throws VECTOR_DIMS_MISMATCH', () =>
      expectInvalid({ v: { type: 'vector' } }, { v: [0.1, 0.2] }, 'VECTOR_DIMS_MISMATCH'));
    test('non-finite throws VECTOR_INVALID_VALUE', () =>
      expectInvalid({ v: { type: 'vector', dims: 2 } }, { v: [Infinity, 0.1] }, 'VECTOR_INVALID_VALUE'));
    test('non-numeric throws VECTOR_INVALID_VALUE', () =>
      expectInvalid({ v: { type: 'vector', dims: 2 } }, { v: ['a', 0.1] }, 'VECTOR_INVALID_VALUE'));
  });

  describe('Enum Validation', () => {
    test('valid enum value passes', () =>
      expectValid({ s: { type: String, enum: ['a','b','c'] } }, { s: 'a' }));
    test('invalid enum value throws FIELD_ENUM_MISMATCH', () =>
      expectInvalid({ s: { type: String, enum: ['a','b'] } }, { s: 'z' }, 'FIELD_ENUM_MISMATCH'));
  });

  describe('Getter/Setter Transformations', () => {
    test('getter transforms value', () => {
      const schema = { name: { type: String, get: (v) => v.toUpperCase() } };
      const obj = { name: 'alice' };
      validate(schema, obj);
      expect(obj.name).toBe('ALICE');
    });
    test('setter transforms value', () => {
      const schema = { name: { type: String, set: (v) => v.trim() } };
      const obj = { name: '  spaced  ' };
      validate(schema, obj);
      expect(obj.name).toBe('spaced');
    });
    test('getter and setter chain', () => {
      const schema = { code: { type: String, get: (v) => v.toUpperCase(), set: (v) => v.slice(0, 4) } };
      const obj = { code: 'abcdefgh' };
      validate(schema, obj);
      expect(obj.code).toBe('ABCD');
    });
  });

  describe('Nested Object Validation', () => {
    test('valid nested passes', () => {
      const schema = { profile: { type: Object, properties: { name: { type: String }, age: { type: Number } } } };
      expectValid(schema, { profile: { name: 'Alice', age: 30 } });
    });
    test('invalid nested property throws', () => {
      const schema = { profile: { type: Object, properties: { name: { type: String }, age: { type: Number } } } };
      expectInvalid(schema, { profile: { name: 'Alice', age: 'thirty' } }, 'FIELD_TYPE_MISMATCH');
    });
    test('nested required missing throws', () => {
      const schema = { profile: { type: Object, properties: { name: { type: String, required: true } } } };
      expectInvalid(schema, { profile: {} }, 'FIELD_REQUIRED');
    });
  });

  describe('Array Items Validation', () => {
    test('matching items pass', () =>
      expectValid({ tags: { type: Array, items: String } }, { tags: ['a','b','c'] }));
    test('mismatched item throws FIELD_ARRAY_ITEM_MISMATCH', () =>
      expectInvalid({ numbers: { type: Array, items: Number } }, { numbers: [1, 2, 'three'] },
        'FIELD_ARRAY_ITEM_MISMATCH'));
    test('number array passes', () =>
      expectValid({ values: { type: Array, items: Number } }, { values: [1, 2, 3] }));
    test('boolean array passes', () =>
      expectValid({ flags: { type: Array, items: Boolean } }, { flags: [true, false, true] }));
  });

  describe('Multiple Fields', () => {
    test('valid multiple-field doc passes', () =>
      expectValid(
        { name: { type: String }, age: { type: Number }, active: { type: Boolean } },
        { name: 'Test', age: 25, active: true }));
    test('first invalid field throws', () =>
      expectInvalid(
        { name: { type: String }, age: { type: Number } },
        { name: 123, age: 'twenty' }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('Unknown Type', () => {
    test('unknown type throws', () =>
      expectInvalid({ field: { type: 'unknown' } }, { field: 'value' }, 'FIELD_TYPE_MISMATCH'));
  });

  describe('checkType helper', () => {
    test('handles new ref|string type', () => {
      expect(checkType('ref|string', 'KGEN_ab1cdef')).toBe(true);
      expect(checkType('ref|string', 'arbitrary literal')).toBe(true);
      expect(checkType('ref|string', '')).toBe(false);
      expect(checkType('ref|string', 42)).toBe(false);
    });
    test('handles new predicate type', () => {
      expect(checkType('predicate', 'works_at')).toBe(true);
      expect(checkType('predicate', '')).toBe(false);
    });
  });
});
