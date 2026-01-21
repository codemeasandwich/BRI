/**
 * @file BRI Remote Examples: Population methods and subscriptions
 * Examples 12-13: POPULATION with .populate(), SUBSCRIPTIONS
 */

import { section, subsection } from './helpers.js';

/**
 * Run population and subscription examples over remote connection
 * @param {Object} db - BRI remote database instance
 * @param {Object} relEntities - Relationship entities from previous examples
 * @returns {Promise<void>}
 */
export async function runPopulateSubsExamples(db, relEntities) {
  const { book1, article } = relEntities;

  // EXAMPLE 12: POPULATION - .populate() method
  section(12, 'POPULATION - .populate() method');

  subsection('Populate single field with .populate()');
  const pop1 = await db.get.book(book1.$ID).populate('author');
  console.log('  db.get.book(id).populate("author")');
  console.log('  -> Author:', pop1.author.name);

  subsection('Populate multiple fields with array');
  const pop2 = await db.get.article(article.$ID).populate(['author', 'editor']);
  console.log('  db.get.article(id).populate(["author", "editor"])');
  console.log('  -> Author:', pop2.author.name, '| Editor:', pop2.editor.name);

  subsection('Chained .populate() calls');
  const pop3 = await db.get.article(article.$ID)
    .populate('author')
    .populate('category');
  console.log('  .populate("author").populate("category")');
  console.log('  -> Author:', pop3.author.name, '| Category:', pop3.category.name);

  // EXAMPLE 13: SUBSCRIPTIONS - db.sub real-time updates
  section(13, 'SUBSCRIPTIONS - db.sub real-time updates');

  const events = [];

  subsection('Subscribe to entity changes');
  const unsubscribe = await db.sub.user(change => {
    events.push(change);
    console.log('    [EVENT]', change.action, 'on', change.target);
  });
  console.log('  const unsub = await db.sub.user(callback)');

  subsection('Trigger CREATE event');
  const subUser = await db.add.user({ name: 'Subscriber Test', email: 'sub@example.com', age: 50 });

  subsection('Trigger UPDATE event');
  subUser.name = 'Subscriber Updated';
  await subUser.save();

  subsection('Trigger DELETE event');
  await db.del.user(subUser.$ID, 'SYSTEM');

  await new Promise(r => setTimeout(r, 100));

  subsection('Unsubscribe');
  unsubscribe();
  console.log('  unsubscribe() - no more events received');

  await db.add.user({ name: 'After Unsub', email: 'after@example.com', age: 51 });
  await new Promise(r => setTimeout(r, 50));

  console.log('  Total events received:', events.length);
}
