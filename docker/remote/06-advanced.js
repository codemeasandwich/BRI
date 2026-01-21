/**
 * @file BRI Remote Examples: Advanced features and practical patterns
 * Examples 18-20: Entity methods, special types, practical patterns
 */

import { section, subsection } from './helpers.js';

/**
 * Run advanced feature examples over remote connection
 * @param {Object} db - BRI remote database instance
 * @param {Object} entities - Entities from previous examples
 * @returns {Promise<void>}
 */
export async function runAdvancedExamples(db, entities) {
  const { alice } = entities;

  // EXAMPLE 18: ENTITY METHODS - Serialization
  section(18, 'ENTITY METHODS - Serialization');

  const entity = await db.get.user(alice.$ID);

  subsection('.toObject() - Plain object');
  const plainObj = entity.toObject();
  console.log('  entity.toObject()');
  console.log('  -> Type:', typeof plainObj);
  console.log('  -> Has $ID:', '$ID' in plainObj);
  console.log('  -> Not reactive (no proxy)');

  subsection('.toJSON() - JSON-serializable');
  const jsonObj = entity.toJSON();
  console.log('  entity.toJSON()');
  console.log('  -> JSON.stringify ready');
  console.log('  -> Sample:', JSON.stringify(jsonObj).slice(0, 60) + '...');

  subsection('.toJSS() - Extended serialization');
  const jssObj = entity.toJSS();
  console.log('  entity.toJSS()');
  console.log('  -> Handles Date, RegExp, Error, Map, Set');

  subsection('.toString() - Returns $ID');
  const str = entity.toString();
  console.log('  entity.toString()');
  console.log('  -> Returns:', str);

  // EXAMPLE 19: SPECIAL DATA TYPES
  section(19, 'SPECIAL DATA TYPES');

  subsection('Date objects');
  const withDate = await db.add.event({
    name: 'Conference',
    startDate: new Date('2024-06-15'),
    endDate: new Date('2024-06-17')
  });
  const fetchedDate = await db.get.event(withDate.$ID);
  console.log('  Dates are preserved as Date instances');
  console.log('  -> startDate:', fetchedDate.startDate instanceof Date);

  subsection('Nested objects with special types');
  const withNested = await db.add.document({
    title: 'Report',
    metadata: {
      created: new Date(),
      modified: new Date()
    }
  });
  console.log('  Nested dates in metadata preserved');

  subsection('Arrays of mixed types');
  const withMixed = await db.add.record({
    data: [1, 'two', { three: 3 }, [4, 5]],
    config: { nested: { deep: true } }
  });
  const fetchedMixed = await db.get.record(withMixed.$ID);
  console.log('  Mixed arrays preserved:', fetchedMixed.data);

  // EXAMPLE 20: PRACTICAL PATTERNS
  section(20, 'PRACTICAL PATTERNS');

  subsection('Pattern: Find or Create');
  const user = await findOrCreate(db, 'user', { email: 'test@example.com' }, { name: 'Test', age: 30 });
  console.log('  findOrCreate("user", { email }, defaults)');
  console.log('  -> Got:', user.name);

  subsection('Pattern: Paginate results (client-side)');
  const allItems = await db.get.userS();
  const page = 1, pageSize = 3;
  const paginated = allItems.slice((page - 1) * pageSize, page * pageSize);
  console.log('  Client-side pagination:');
  console.log('  -> Page', page, 'of', Math.ceil(allItems.length / pageSize));
  console.log('  -> Items:', paginated.map(u => u.name).join(', '));

  subsection('Pattern: Sort results (client-side)');
  const sorted = [...allItems].sort((a, b) => a.age - b.age);
  console.log('  Client-side sort by age:');
  console.log('  -> Sorted:', sorted.slice(0, 3).map(u => `${u.name}(${u.age})`).join(', ') + '...');

  subsection('Pattern: Aggregate (client-side)');
  const avgAge = allItems.reduce((sum, u) => sum + (u.age || 0), 0) / allItems.length;
  console.log('  Client-side aggregation:');
  console.log('  -> Avg age:', avgAge.toFixed(1));

  subsection('Pattern: Batch create');
  const usersToCreate = [
    { name: 'Batch1', email: 'b1@example.com', age: 31 },
    { name: 'Batch2', email: 'b2@example.com', age: 32 },
    { name: 'Batch3', email: 'b3@example.com', age: 33 }
  ];
  const created = await Promise.all(usersToCreate.map(u => db.add.user(u)));
  console.log('  Promise.all for batch create:');
  console.log('  -> Created:', created.length, 'users');

  subsection('Pattern: Batch update');
  const toUpdate = await db.get.userS(u => u.name.startsWith('Batch'));
  await Promise.all(toUpdate.map(async u => {
    u.verified = true;
    return u.save();
  }));
  console.log('  Batch update with Promise.all');

  subsection('Pattern: Cascade delete (manual)');
  const parent = await db.add.parent({ name: 'Parent' });
  await db.add.child({ name: 'Child1', parent: parent.$ID });
  await db.add.child({ name: 'Child2', parent: parent.$ID });

  const children = await db.get.childS(c => c.parent === parent.$ID);
  await Promise.all(children.map(c => db.del.child(c.$ID, 'SYSTEM')));
  await db.del.parent(parent.$ID, 'SYSTEM');
  console.log('  Manual cascade delete: children first, then parent');

  subsection('Pattern: Type-safe ID validation');
  console.log('  isValidId("USER_abc", "user"):', isValidId('USER_abc', 'user'));
  console.log('  isValidId("POST_abc", "user"):', isValidId('POST_abc', 'user'));
}

/**
 * Find an existing entity or create a new one
 * @param {Object} db - BRI database instance
 * @param {string} type - Entity type
 * @param {Object} query - Query to find existing entity
 * @param {Object} defaults - Default values for new entity
 * @returns {Promise<Object>} Found or created entity
 */
async function findOrCreate(db, type, query, defaults) {
  const existing = await db.get[type + 'S'](item => {
    return Object.entries(query).every(([k, v]) => item[k] === v);
  });
  if (existing.length > 0) return existing[0];
  return db.add[type]({ ...query, ...defaults });
}

/**
 * Validate that an ID matches expected type prefix
 * @param {string} id - The ID to validate
 * @param {string} expectedType - Expected entity type
 * @returns {boolean} Whether the ID is valid
 */
function isValidId(id, expectedType) {
  if (typeof id !== 'string') return false;
  const prefix = id.split('_')[0];
  return prefix === expectedType.toUpperCase().slice(0, 4).padEnd(4, expectedType.toUpperCase().slice(-1));
}
