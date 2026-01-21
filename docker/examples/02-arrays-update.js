/**
 * @file BRI Examples: Array operations, updates, and replacements
 * Examples 6-8: Get by array of IDs, UPDATE patterns, REPLACE patterns
 */

import { section, subsection } from './helpers.js';

/**
 * Run array and update examples
 * @param {Object} db - BRI database instance
 * @param {Object} entities - Entities from previous examples
 * @returns {Promise<void>}
 */
export async function runArrayUpdateExamples(db, entities) {
  const { alice, bob, charlie, diana, eve, system, frank } = entities;

  // EXAMPLE 6: GET BY ARRAY OF IDS
  section(6, 'GET BY ARRAY OF IDS');

  subsection('Recommended: Promise.all with individual gets');
  const ids = [alice.$ID, bob.$ID, charlie.$ID];
  const byIds = await Promise.all(ids.map(id => db.get.user(id)));
  console.log('  Promise.all(ids.map(id => db.get.user(id)))');
  console.log('  -> Fetched:', byIds.map(u => u?.name).join(', '));

  subsection('Alternative: Filter from all');
  const targetIds = new Set([alice.$ID, diana.$ID]);
  const filtered = await db.get.userS(user => targetIds.has(user.$ID));
  console.log('  db.get.userS(user => targetIds.has(user.$ID))');
  console.log('  -> Filtered:', filtered.map(u => u.name).join(', '));

  // EXAMPLE 7: UPDATE - Reactive .save() patterns
  section(7, 'UPDATE - Reactive .save() patterns');

  subsection('Simple property update');
  const userToUpdate = await db.get.user(alice.$ID);
  userToUpdate.name = 'Alice Updated';
  await userToUpdate.save();
  console.log('  user.name = "Alice Updated"; await user.save()');
  console.log('  -> Updated:', (await db.get.user(alice.$ID)).name);

  subsection('Multiple property updates (batched)');
  const multi = await db.get.user(bob.$ID);
  multi.name = 'Bob Smith';
  multi.age = 36;
  multi.email = 'bob.smith@example.com';
  await multi.save();
  console.log('  Modify multiple props, then save once');
  console.log('  -> Batched update applied');

  subsection('Nested property update');
  const nested = await db.get.user(bob.$ID);
  nested.profile.bio = 'Senior Software Developer';
  nested.profile.location.city = 'San Francisco';
  await nested.save();
  console.log('  user.profile.bio = "..."; user.profile.location.city = "..."');
  console.log('  -> Nested updated:', (await db.get.user(bob.$ID)).profile.location.city);

  subsection('Add new property');
  const addProp = await db.get.user(alice.$ID);
  addProp.phone = '+1-555-0123';
  addProp.verified = true;
  await addProp.save();
  console.log('  user.phone = "..."; user.verified = true');
  console.log('  -> New props added');

  subsection('Array element update');
  const arrUpdate = await db.get.user(charlie.$ID);
  arrUpdate.roles[0] = 'superadmin';
  await arrUpdate.save();
  console.log('  user.roles[0] = "superadmin"');
  console.log('  -> Array updated:', (await db.get.user(charlie.$ID)).roles);

  subsection('Array push');
  const arrPush = await db.get.user(charlie.$ID);
  arrPush.roles.push('moderator');
  await arrPush.save();
  console.log('  user.roles.push("moderator")');
  console.log('  -> After push:', (await db.get.user(charlie.$ID)).roles);

  subsection('Save with saveBy option');
  const saveBySave = await db.get.user(diana.$ID);
  saveBySave.name = 'Diana Prince';
  await saveBySave.save({ saveBy: alice.$ID });
  console.log('  await user.save({ saveBy: editor.$ID })');

  subsection('Save with tag option');
  const tagSave = await db.get.user(eve.$ID);
  tagSave.name = 'Eve Wilson';
  await tagSave.save({ tag: 'name-update-batch' });
  console.log('  await user.save({ tag: "name-update-batch" })');

  // EXAMPLE 8: REPLACE - db.set patterns
  section(8, 'REPLACE - db.set patterns');

  subsection('Replace entire entity (must include $ID)');
  await db.set.user({
    $ID: frank.$ID,
    name: 'Franklin',
    email: 'franklin@example.com',
    age: 42,
    newField: 'added by set'
  });
  const replaced = await db.get.user(frank.$ID);
  console.log('  db.set.user({ $ID, name, email, age, newField })');
  console.log('  -> Replaced:', replaced.name, '- newField:', replaced.newField);

  subsection('Replace with saveBy option');
  await db.set.user(
    { $ID: frank.$ID, name: 'Franklin Jr', email: 'frank@example.com', age: 42 },
    { saveBy: alice.$ID }
  );
  console.log('  db.set.user(data, { saveBy })');

  subsection('Replace with tag option');
  await db.set.user(
    { $ID: frank.$ID, name: 'Frank', email: 'frank@example.com', age: 43 },
    { tag: 'data-correction' }
  );
  console.log('  db.set.user(data, { tag })');
}
