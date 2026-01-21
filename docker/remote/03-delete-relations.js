/**
 * @file BRI Remote Examples: Delete operations and relationships
 * Examples 9-11: DELETE soft delete, RELATIONSHIPS, POPULATION with .and
 */

import { section, subsection } from './helpers.js';

/**
 * Run delete and relationship examples over remote connection
 * @param {Object} db - BRI remote database instance
 * @param {Object} entities - Entities from previous examples
 * @returns {Promise<Object>} Created relationship entities
 */
export async function runDeleteRelationExamples(db, entities) {
  const { alice } = entities;

  // EXAMPLE 9: DELETE - db.del soft delete
  section(9, 'DELETE - db.del soft delete');

  const tempUser = await db.add.user({ name: 'Temporary', email: 'temp@example.com', age: 99 });

  subsection('Soft delete by $ID string');
  const deleted = await db.del.user(tempUser.$ID, alice.$ID);
  console.log('  db.del.user(id, deletedBy)');
  console.log('  -> Deleted:', deleted.name);
  console.log('  -> Returns entity without deletedAt/deletedBy metadata');

  const afterDelete = await db.get.user(tempUser.$ID);
  console.log('  -> After delete, get returns:', afterDelete);

  subsection('Delete by object with $ID');
  const tempUser2 = await db.add.user({ name: 'Temp2', email: 'temp2@example.com', age: 98 });
  await db.del.user({ $ID: tempUser2.$ID }, alice.$ID);
  console.log('  db.del.user({ $ID }, deletedBy)');

  subsection('Delete with SYSTEM as deletedBy');
  const tempUser3 = await db.add.user({ name: 'Temp3', email: 'temp3@example.com', age: 97 });
  await db.del.user(tempUser3.$ID, 'SYSTEM');
  console.log('  db.del.user(id, "SYSTEM")');

  subsection('Deleted entities excluded from queries');
  const remaining = await db.get.userS(u => u.name.startsWith('Temp'));
  console.log('  Deleted users not in db.get.userS() results');
  console.log('  -> Remaining "Temp" users:', remaining.length);

  // EXAMPLE 10: RELATIONSHIPS - Creating references
  section(10, 'RELATIONSHIPS - Creating references');

  const author1 = await db.add.author({ name: 'Jane Austen', bio: 'English novelist' });
  const author2 = await db.add.author({ name: 'Charles Dickens', bio: 'Victorian novelist' });

  const tag1 = await db.add.tag({ name: 'fiction', color: '#3498db' });
  const tag2 = await db.add.tag({ name: 'classic', color: '#e74c3c' });

  const category = await db.add.category({ name: 'Literature', slug: 'literature' });

  subsection('One-to-one reference (store $ID)');
  const book1 = await db.add.book({
    title: 'Pride and Prejudice',
    year: 1813,
    author: author1.$ID
  });
  console.log('  book.author = author.$ID');
  console.log('  -> Stored as:', book1.author);

  subsection('One-to-many reference (array of $IDs)');
  const book2 = await db.add.book({
    title: 'Oliver Twist',
    year: 1837,
    author: author2.$ID,
    tags: [tag1.$ID, tag2.$ID]
  });
  console.log('  book.tags = [tag1.$ID, tag2.$ID]');
  console.log('  -> Stored as:', book2.tags);

  subsection('Multiple one-to-one references');
  const article = await db.add.article({
    title: 'The Art of Writing',
    author: author1.$ID,
    editor: author2.$ID,
    category: category.$ID
  });
  console.log('  Multiple refs: author, editor, category');

  // EXAMPLE 11: POPULATION - .and.field syntax
  section(11, 'POPULATION - .and.field syntax');

  subsection('Populate single reference');
  const book = await db.get.book(book1.$ID);
  console.log('  Before: book.author =', book.author, '(just ID)');

  const bookWithAuthor = await book.and.author;
  console.log('  After book.and.author:');
  console.log('  -> book.author.name =', bookWithAuthor.author.name);
  console.log('  -> book.author.bio =', bookWithAuthor.author.bio);

  subsection('Populate array of references');
  const bookWithTags = await db.get.book(book2.$ID);
  const populated = await bookWithTags.and.tags;
  console.log('  book.and.tags (array population):');
  console.log('  -> tags:', populated.tags.map(t => t.name).join(', '));

  subsection('Chained population');
  const profile = await db.add.profile({ avatar: 'avatar.jpg', website: 'https://janeausten.com' });
  const authorWithProfile = await db.get.author(author1.$ID);
  authorWithProfile.profile = profile.$ID;
  await authorWithProfile.save();

  const freshBook = await db.get.book(book1.$ID);
  const withAuthor = await freshBook.and.author;
  const withProfile = await withAuthor.author.and.profile;
  console.log('  Chained: book.and.author -> author.and.profile');
  console.log('  -> Profile website:', withProfile.profile.website);

  subsection('Multiple populations (sequential)');
  const art = await db.get.article(article.$ID);
  const withAuthor2 = await art.and.author;
  const withEditor = await withAuthor2.and.editor;
  const withCategory = await withEditor.and.category;
  console.log('  article.and.author.and.editor.and.category');
  console.log('  -> Author:', withCategory.author.name);
  console.log('  -> Editor:', withCategory.editor.name);
  console.log('  -> Category:', withCategory.category.name);

  return { author1, author2, book1, book2, article, category };
}
