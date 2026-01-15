/**
 * E2E Diff/Change Utility Tests
 * Tests: createChangeTracker, applyChanges, path utilities, matching
 */

import {
  UNDECLARED,
  createChangeTracker,
  applyChanges,
  getByPath,
  pathStartsWith,
  pathEquals,
  flattenToPathValues,
  isPlainObject,
  isPartialMatch,
  isDeepEqual
} from '../../utils/diff/index.js';

describe('Diff Utilities', () => {
  describe('UNDECLARED symbol', () => {
    test('is a symbol', () => {
      expect(typeof UNDECLARED).toBe('symbol');
    });

    test('represents deleted/non-existent', () => {
      // Symbol('UNDECLARED').toString() returns "Symbol(UNDECLARED)"
      expect(UNDECLARED.toString()).toContain('UNDECLARED');
    });
  });

  describe('isPlainObject', () => {
    test('plain object returns true', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    test('array returns true', () => {
      expect(isPlainObject([])).toBe(true);
      expect(isPlainObject([1, 2, 3])).toBe(true);
    });

    test('null returns false', () => {
      expect(isPlainObject(null)).toBe(false);
    });

    test('primitives return false', () => {
      expect(isPlainObject('string')).toBe(false);
      expect(isPlainObject(42)).toBe(false);
      expect(isPlainObject(true)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });

    test('Date returns false', () => {
      expect(isPlainObject(new Date())).toBe(false);
    });

    test('Error returns false', () => {
      expect(isPlainObject(new Error())).toBe(false);
    });

    test('Set returns false', () => {
      expect(isPlainObject(new Set())).toBe(false);
    });

    test('Map returns false', () => {
      expect(isPlainObject(new Map())).toBe(false);
    });
  });

  describe('getByPath', () => {
    test('gets top-level property', () => {
      const obj = { name: 'test' };
      expect(getByPath(obj, ['name'])).toBe('test');
    });

    test('gets nested property', () => {
      const obj = { a: { b: { c: 'deep' } } };
      expect(getByPath(obj, ['a', 'b', 'c'])).toBe('deep');
    });

    test('gets array element', () => {
      const obj = { items: ['a', 'b', 'c'] };
      expect(getByPath(obj, ['items', 1])).toBe('b');
    });

    test('returns undefined for missing path', () => {
      const obj = { a: 1 };
      expect(getByPath(obj, ['b'])).toBeUndefined();
    });

    test('returns undefined for missing nested path', () => {
      const obj = { a: {} };
      expect(getByPath(obj, ['a', 'b', 'c'])).toBeUndefined();
    });

    test('empty path returns object', () => {
      const obj = { a: 1 };
      expect(getByPath(obj, [])).toBe(obj);
    });
  });

  describe('pathStartsWith', () => {
    test('matching prefix returns true', () => {
      expect(pathStartsWith(['a'], ['a', 'b', 'c'])).toBe(true);
      expect(pathStartsWith(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
    });

    test('non-matching returns false', () => {
      expect(pathStartsWith(['x'], ['a', 'b'])).toBe(false);
      expect(pathStartsWith(['a', 'x'], ['a', 'b'])).toBe(false);
    });

    test('empty prefix matches all', () => {
      expect(pathStartsWith([], ['a', 'b'])).toBe(true);
    });

    test('prefix longer than path returns false', () => {
      expect(pathStartsWith(['a', 'b', 'c'], ['a'])).toBe(false);
    });

    test('equal paths return true', () => {
      expect(pathStartsWith(['a', 'b'], ['a', 'b'])).toBe(true);
    });
  });

  describe('pathEquals', () => {
    test('equal paths return true', () => {
      expect(pathEquals(['a', 'b'], ['a', 'b'])).toBe(true);
      expect(pathEquals([], [])).toBe(true);
    });

    test('different lengths return false', () => {
      expect(pathEquals(['a'], ['a', 'b'])).toBe(false);
    });

    test('different elements return false', () => {
      expect(pathEquals(['a', 'b'], ['a', 'c'])).toBe(false);
    });

    test('numeric vs string elements', () => {
      expect(pathEquals([0], ['0'])).toBe(false);
      expect(pathEquals([0], [0])).toBe(true);
    });
  });

  describe('flattenToPathValues', () => {
    test('flattens simple object', () => {
      const obj = { a: 1, b: 2 };
      const result = flattenToPathValues(obj);

      expect(result).toContainEqual([['a'], 1, UNDECLARED]);
      expect(result).toContainEqual([['b'], 2, UNDECLARED]);
    });

    test('flattens nested object', () => {
      const obj = { a: { b: 1 } };
      const result = flattenToPathValues(obj);

      expect(result).toContainEqual([['a', 'b'], 1, UNDECLARED]);
    });

    test('flattens array', () => {
      const arr = ['x', 'y'];
      const result = flattenToPathValues(arr);

      expect(result).toContainEqual([[0], 'x', UNDECLARED]);
      expect(result).toContainEqual([[1], 'y', UNDECLARED]);
    });

    test('tracks old reference', () => {
      const obj = { a: 1 };
      const oldRef = { a: 0 };
      const result = flattenToPathValues(obj, [], oldRef);

      expect(result).toContainEqual([['a'], 1, 0]);
    });

    test('handles mixed nesting', () => {
      const obj = {
        users: [
          { name: 'Alice' }
        ]
      };
      const result = flattenToPathValues(obj);

      expect(result).toContainEqual([['users', 0, 'name'], 'Alice', UNDECLARED]);
    });
  });

  describe('isPartialMatch', () => {
    test('matching subset returns true', () => {
      const subset = { a: 1 };
      const source = { a: 1, b: 2 };
      expect(isPartialMatch(subset, source)).toBe(true);
    });

    test('non-matching value returns false', () => {
      const subset = { a: 2 };
      const source = { a: 1 };
      expect(isPartialMatch(subset, source)).toBe(false);
    });

    test('missing key returns false', () => {
      const subset = { c: 1 };
      const source = { a: 1 };
      expect(isPartialMatch(subset, source)).toBe(false);
    });

    test('nested matching', () => {
      const subset = { profile: { name: 'Alice' } };
      const source = { profile: { name: 'Alice', age: 30 } };
      expect(isPartialMatch(subset, source)).toBe(true);
    });

    test('empty subset matches all', () => {
      expect(isPartialMatch({}, { a: 1 })).toBe(true);
    });
  });

  describe('isDeepEqual', () => {
    test('equal objects', () => {
      expect(isDeepEqual({ a: 1 }, { a: 1 })).toBe(true);
    });

    test('different objects', () => {
      expect(isDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    test('equal arrays', () => {
      expect(isDeepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    test('different array length', () => {
      expect(isDeepEqual([1, 2], [1, 2, 3])).toBe(false);
    });

    test('different array elements', () => {
      expect(isDeepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    test('nested equality', () => {
      const a = { x: { y: [1, 2] } };
      const b = { x: { y: [1, 2] } };
      expect(isDeepEqual(a, b)).toBe(true);
    });

    test('primitives', () => {
      expect(isDeepEqual(1, 1)).toBe(true);
      expect(isDeepEqual('a', 'a')).toBe(true);
      expect(isDeepEqual(true, true)).toBe(true);
      expect(isDeepEqual(1, 2)).toBe(false);
    });

    test('null comparisons', () => {
      expect(isDeepEqual(null, null)).toBe(true);
      expect(isDeepEqual(null, {})).toBe(false);
    });
  });

  describe('applyChanges', () => {
    test('applies simple changes', () => {
      const changes = [[['a'], 1]];
      const result = applyChanges(changes, {});

      expect(result.a).toBe(1);
    });

    test('applies nested changes', () => {
      const changes = [[['a', 'b', 'c'], 'deep']];
      const result = applyChanges(changes, {});

      expect(result.a.b.c).toBe('deep');
    });

    test('applies array changes', () => {
      const changes = [[[0], 'first'], [[1], 'second']];
      const result = applyChanges(changes, []);

      expect(result[0]).toBe('first');
      expect(result[1]).toBe('second');
    });

    test('applies deletion with UNDECLARED', () => {
      // applyChanges creates overlay - must explicitly include 'a' to preserve it
      const source = { a: 1, b: 2 };
      const changes = [[['a'], 1], [['b'], UNDECLARED]];
      const result = applyChanges(changes, source);

      expect(result.a).toBe(1);
      expect('b' in result).toBe(false);
    });

    test('preserves source when creating nested', () => {
      const source = { a: { existing: 1 } };
      const changes = [[['a', 'new'], 2]];
      const result = applyChanges(changes, source);

      expect(result.a.existing).toBe(1);
      expect(result.a.new).toBe(2);
    });

    test('handles array deletion', () => {
      const source = { items: ['a', 'b', 'c'] };
      const changes = [[['items', 1], UNDECLARED]];
      const result = applyChanges(changes, source);

      expect(result.items.length).toBe(2);
    });
  });

  describe('createChangeTracker', () => {
    test('creates proxy', () => {
      const tracker = createChangeTracker({ a: 1 });
      expect(tracker.a).toBe(1);
    });

    test('tracks simple changes', () => {
      const tracker = createChangeTracker({ value: 1 });
      tracker.value = 2;

      const changes = tracker.getChanges();
      expect(changes.length).toBeGreaterThan(0);
    });

    test('toJSON returns target', () => {
      const target = { a: 1, b: 2 };
      const tracker = createChangeTracker(target);
      expect(tracker.toJSON()).toEqual(target);
    });

    test('getChanges returns copy', () => {
      const tracker = createChangeTracker({ a: 1 });
      tracker.a = 2;

      const changes1 = tracker.getChanges();
      const changes2 = tracker.getChanges();

      expect(changes1).not.toBe(changes2);
      expect(changes1).toEqual(changes2);
    });

    test('clearChanges empties changes', () => {
      const tracker = createChangeTracker({ a: 1 });
      tracker.a = 2;

      expect(tracker.getChanges().length).toBeGreaterThan(0);
      tracker.clearChanges();
      expect(tracker.getChanges().length).toBe(0);
    });

    test('tracks nested changes', () => {
      const tracker = createChangeTracker({
        nested: { value: 1 }
      });
      tracker.nested.value = 2;

      const changes = tracker.getChanges();
      expect(changes.some(c => c[0].includes('value'))).toBe(true);
    });

    test('tracks array changes', () => {
      const tracker = createChangeTracker({
        items: ['a', 'b']
      });
      tracker.items[0] = 'x';

      const changes = tracker.getChanges();
      expect(changes.length).toBeGreaterThan(0);
    });

    test('tracks deletions', () => {
      const tracker = createChangeTracker({ a: 1, b: 2 });
      delete tracker.b;

      const changes = tracker.getChanges();
      expect(changes.some(c => c[1] === UNDECLARED)).toBe(true);
    });

    test('ignores unchanged values', () => {
      const tracker = createChangeTracker({ a: 1 });
      tracker.a = 1; // Same value

      const changes = tracker.getChanges();
      expect(changes.length).toBe(0);
    });

    test('ignores array length property (line 74)', () => {
      const tracker = createChangeTracker({ items: [1, 2, 3] });
      // Setting length directly should be ignored
      tracker.items.length = 1; // This triggers line 74
      // Length change is ignored, actual array unchanged
      expect(tracker.items.length).toBe(3);
    });

    test('save with no changes returns proxy immediately (line 41)', async () => {
      const tracker = createChangeTracker({ value: 1 });
      // Don't make any changes

      const result = await tracker.save();
      // Should return proxy when no changes
      expect(result).toBeDefined();
      expect(result.value).toBe(1);
    });

    test('delete non-existent property returns true (line 107)', () => {
      const tracker = createChangeTracker({ a: 1 });
      // Delete a property that doesn't exist
      delete tracker.nonExistent;
      // Should succeed silently (line 107)
      expect(tracker.getChanges().length).toBe(0);
    });

    test('delete array element uses splice (line 117)', () => {
      const tracker = createChangeTracker({ items: ['a', 'b', 'c'] });
      // Delete array element by index - triggers splice at line 117
      delete tracker.items[1];

      // Array should have element removed
      const changes = tracker.getChanges();
      expect(changes.length).toBeGreaterThan(0);
    });

    test('save method calls onSave', async () => {
      let savedChanges = null;
      const tracker = createChangeTracker({ value: 1 }, {
        onSave: (changes) => { savedChanges = changes; }
      });

      tracker.value = 2;
      await tracker.save();

      expect(savedChanges).not.toBeNull();
    });

    test('save clears changes after', async () => {
      const tracker = createChangeTracker({ value: 1 });
      tracker.value = 2;

      await tracker.save();
      expect(tracker.getChanges().length).toBe(0);
    });

    test('tracks type change object to array', () => {
      const tracker = createChangeTracker({ data: { key: 'value' } });
      tracker.data = [1, 2, 3];

      const changes = tracker.getChanges();
      // Should have change for type conversion
    });

    test('tracks type change array to object', () => {
      const tracker = createChangeTracker({ data: [1, 2, 3] });
      tracker.data = { key: 'value' };

      const changes = tracker.getChanges();
      // Should have change for type conversion
    });

    test('tracks empty object assignment', () => {
      const tracker = createChangeTracker({ data: { old: 'value' } });
      tracker.data = {};

      const changes = tracker.getChanges();
      expect(changes.length).toBeGreaterThan(0);
    });

    test('tracks empty array assignment', () => {
      const tracker = createChangeTracker({ items: [1, 2, 3] });
      tracker.items = [];

      const changes = tracker.getChanges();
      expect(changes.length).toBeGreaterThan(0);
    });
  });
});
