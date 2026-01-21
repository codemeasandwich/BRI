/**
 * @file BRI Examples: CRUD operations and filtering
 * Examples 1-5: CREATE, READ single/all, FILTER with objects and functions
 */

import { section, subsection } from './helpers.js';

/**
 * Run CRUD and filtering examples
 * @param {Object} db - BRI database instance
 * @returns {Promise<Object>} Created entities for use in other examples
 */
export async function runCrudExamples(db) {
  // EXAMPLE 1: CREATE - All db.add patterns
  section(1, 'CREATE - All db.add patterns');

  subsection('Basic create with dot notation');
  const alice = await db.add.user({ name: 'Alice', email: 'alice@example.com', age: 28 });
  console.log('  db.add.user({ name, email, age })');
  console.log('  -> Created:', alice.$ID, '| name:', alice.name);

  subsection('Create with nested objects');
  const bob = await db.add.user({
    name: 'Bob',
    email: 'bob@example.com',
    age: 35,
    profile: {
      bio: 'Software developer',
      location: { city: 'NYC', country: 'USA' }
    }
  });
  console.log('  db.add.user({ profile: { location: { city, country } } })');
  console.log('  -> Nested:', bob.profile.location.city);

  subsection('Create with arrays');
  const charlie = await db.add.user({
    name: 'Charlie',
    email: 'charlie@example.com',
    age: 22,
    roles: ['admin', 'editor'],
    scores: [95, 87, 92]
  });
  console.log('  db.add.user({ roles: [...], scores: [...] })');
  console.log('  -> Arrays:', charlie.roles.join(', '));

  subsection('Create with saveBy option (audit trail)');
  const diana = await db.add.user(
    { name: 'Diana', email: 'diana@example.com', age: 30 },
    { saveBy: alice.$ID }
  );
  console.log('  db.add.user(data, { saveBy: alice.$ID })');
  console.log('  -> Created by:', alice.$ID);

  subsection('Create with tag option (categorization)');
  const eve = await db.add.user(
    { name: 'Eve', email: 'eve@example.com', age: 25 },
    { tag: 'batch-import-2024' }
  );
  console.log('  db.add.user(data, { tag: "batch-import-2024" })');

  subsection('Create with saveBy=true (self-reference)');
  const system = await db.add.user(
    { name: 'System', email: 'system@example.com', age: 0 },
    { saveBy: true }
  );
  console.log('  db.add.user(data, { saveBy: true })');
  console.log('  -> Self-referenced creation');

  subsection('Create with combined options');
  const frank = await db.add.user(
    { name: 'Frank', email: 'frank@example.com', age: 40 },
    { saveBy: alice.$ID, tag: 'vip-users' }
  );
  console.log('  db.add.user(data, { saveBy, tag })');

  subsection('Auto-generated fields');
  console.log('  Every entity automatically gets:');
  console.log('  -> $ID:', alice.$ID, '(format: TYPE_uniqueid)');
  console.log('  -> createdAt:', alice.createdAt);
  console.log('  -> updatedAt:', alice.updatedAt);

  // EXAMPLE 2: READ SINGLE - db.get.type() patterns
  section(2, 'READ SINGLE - db.get.type() patterns');

  subsection('Get by $ID string');
  const getById = await db.get.user(alice.$ID);
  console.log('  db.get.user("USER_xxx")');
  console.log('  -> Found:', getById?.name);

  subsection('Get by object with $ID');
  const getByObj = await db.get.user({ $ID: bob.$ID });
  console.log('  db.get.user({ $ID: "USER_xxx" })');
  console.log('  -> Found:', getByObj?.name);

  subsection('Get returns null if not found');
  const notFound = await db.get.user('USER_doesnotexist');
  console.log('  db.get.user("USER_doesnotexist")');
  console.log('  -> Returns:', notFound);

  // EXAMPLE 3: READ ALL - db.get.typeS() plural patterns
  section(3, 'READ ALL - db.get.typeS() plural patterns');

  subsection('Get ALL entities (uppercase S suffix for plural)');
  const allUsers = await db.get.userS();
  console.log('  db.get.userS()');
  console.log('  -> Returns array of', allUsers.length, 'users');
  console.log('  -> Names:', allUsers.map(u => u.name).join(', '));

  subsection('Empty collection returns empty array');
  const emptyCollection = await db.get.emptytypeS();
  console.log('  db.get.emptytypeS()');
  console.log('  -> Returns:', emptyCollection, '(empty array)');

  // EXAMPLE 4: FILTER WITH OBJECT QUERY - Exact property matching
  section(4, 'FILTER WITH OBJECT QUERY - Exact property matching');

  subsection('Filter by single property');
  const admins = await db.get.userS({ roles: ['admin', 'editor'] });
  console.log('  db.get.userS({ roles: ["admin", "editor"] })');
  console.log('  -> Exact array match:', admins.map(u => u.name).join(', ') || '(none)');

  subsection('Filter by nested object property');
  const nycUsers = await db.get.userS({ profile: { location: { city: 'NYC' } } });
  console.log('  db.get.userS({ profile: { location: { city: "NYC" } } })');
  console.log('  -> NYC users:', nycUsers.map(u => u.name).join(', ') || '(none)');

  subsection('Object query uses exact matching (isMatch)');
  console.log('  NOTE: BRI uses EXACT matching, not partial matching');
  console.log('  -> { age: 28 } matches only if age === 28');
  console.log('  -> Nested objects must match all specified keys');

  // EXAMPLE 5: FILTER WITH FUNCTION - Full JavaScript power
  section(5, 'FILTER WITH FUNCTION - Full JavaScript power');

  subsection('Filter with comparison operators');
  const over30 = await db.get.userS(user => user.age > 30);
  console.log('  db.get.userS(user => user.age > 30)');
  console.log('  -> Over 30:', over30.map(u => `${u.name}(${u.age})`).join(', '));

  subsection('Filter with string methods');
  const startsWithA = await db.get.userS(user => user.name.startsWith('A'));
  console.log('  db.get.userS(user => user.name.startsWith("A"))');
  console.log('  -> Starts with A:', startsWithA.map(u => u.name).join(', '));

  subsection('Filter with AND logic');
  const andFilter = await db.get.userS(user => user.age > 25 && user.age < 35);
  console.log('  db.get.userS(user => user.age > 25 && user.age < 35)');
  console.log('  -> 25 < age < 35:', andFilter.map(u => `${u.name}(${u.age})`).join(', '));

  subsection('Filter with OR logic');
  const orFilter = await db.get.userS(user => user.age < 25 || user.age > 35);
  console.log('  db.get.userS(user => user.age < 25 || user.age > 35)');
  console.log('  -> age<25 OR age>35:', orFilter.map(u => `${u.name}(${u.age})`).join(', '));

  subsection('Filter checking array contents');
  const hasAdminRole = await db.get.userS(user => user.roles?.includes('admin'));
  console.log('  db.get.userS(user => user.roles?.includes("admin"))');
  console.log('  -> Has admin role:', hasAdminRole.map(u => u.name).join(', ') || '(none)');

  subsection('Filter with optional chaining for nested props');
  const hasCity = await db.get.userS(user => user.profile?.location?.city === 'NYC');
  console.log('  db.get.userS(user => user.profile?.location?.city === "NYC")');
  console.log('  -> NYC residents:', hasCity.map(u => u.name).join(', ') || '(none)');

  return { alice, bob, charlie, diana, eve, system, frank };
}
