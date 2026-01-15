/**
 * BRI Example - Demonstrating all core features
 *
 * Run with: bun run start
 */

import { createDB } from 'bri';

async function main() {
  console.log('=== BRI Example ===\n');

  // ============================================
  // 1. Initialize Database
  // ============================================
  console.log('1. Initializing database...');
  const db = await createDB({
    storeConfig: {
      dataDir: './data',
      maxMemoryMB: 64
    }
  });

  // ============================================
  // 2. Create Documents (db.add)
  // ============================================
  console.log('\n2. Creating documents...');

  const alice = await db.add.user({
    name: 'Alice',
    email: 'alice@example.com',
    age: 28
  });
  console.log(`   Created user: ${alice.$ID}`);
  console.log(`   Name: ${alice.name}, Email: ${alice.email}`);

  const bob = await db.add.user({
    name: 'Bob',
    email: 'bob@example.com',
    age: 32
  });
  console.log(`   Created user: ${bob.$ID}`);

  // ============================================
  // 3. Read Documents (db.get)
  // ============================================
  console.log('\n3. Reading documents...');

  // Get by ID
  const fetchedAlice = await db.get.user(alice.$ID);
  console.log(`   Fetched by ID: ${fetchedAlice.name}`);

  // Get by query object
  const foundBob = await db.get.user({ email: 'bob@example.com' });
  console.log(`   Found by email: ${foundBob.name}`);

  // Get all (plural form with 'S')
  const allUsers = await db.get.userS();
  console.log(`   Total users: ${allUsers.length}`);

  // Get with filter function
  const adults = await db.get.userS(user => user.age >= 30);
  console.log(`   Users 30+: ${adults.length} (${adults.map(u => u.name).join(', ')})`);

  // ============================================
  // 4. Update Documents (.save())
  // ============================================
  console.log('\n4. Updating documents...');

  fetchedAlice.name = 'Alice Smith';
  fetchedAlice.age = 29;
  await fetchedAlice.save();
  console.log(`   Updated Alice: ${fetchedAlice.name}, age ${fetchedAlice.age}`);

  // Verify update persisted
  const verifyAlice = await db.get.user(alice.$ID);
  console.log(`   Verified from DB: ${verifyAlice.name}`);

  // ============================================
  // 5. Relationships (.and.fieldName)
  // ============================================
  console.log('\n5. Working with relationships...');

  // Create a post with author reference
  const post = await db.add.post({
    title: 'Hello World',
    content: 'This is my first post!',
    author: alice.$ID
  });
  console.log(`   Created post: ${post.$ID}`);
  console.log(`   Author ID: ${post.author}`);

  // Populate the author field (note: .and.fieldName is a property, not a method)
  const postWithAuthor = await post.and.author;
  console.log(`   Populated author: ${postWithAuthor.author.name}`);

  // Create a post with multiple references
  const post2 = await db.add.post({
    title: 'Collaboration',
    content: 'Working together!',
    author: bob.$ID,
    mentions: [alice.$ID, bob.$ID]
  });

  // Populate multiple fields
  const fullPost = await post2.and.author;
  const withMentions = await fullPost.and.mentions;
  console.log(`   Post by ${withMentions.author.name} mentions: ${withMentions.mentions.map(u => u.name).join(', ')}`);

  // ============================================
  // 6. Subscriptions (db.sub)
  // ============================================
  console.log('\n6. Testing subscriptions...');

  let changeCount = 0;
  const unsubscribe = await db.sub.user(change => {
    changeCount++;
    console.log(`   [SUB] ${change.action} on ${change.target}`);
  });

  // Trigger some changes
  const charlie = await db.add.user({ name: 'Charlie', email: 'charlie@example.com', age: 25 });
  charlie.age = 26;
  await charlie.save();

  // Give subscription time to receive events
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(`   Received ${changeCount} change events`);

  // Unsubscribe
  unsubscribe();

  // ============================================
  // 7. Replace Documents (db.set)
  // ============================================
  console.log('\n7. Replacing documents...');

  const replacement = {
    $ID: charlie.$ID,
    name: 'Charles',
    email: 'charles@example.com',
    age: 27,
    role: 'admin'
  };
  await db.set.user(replacement);

  const replaced = await db.get.user(charlie.$ID);
  console.log(`   Replaced: ${replaced.name}, role: ${replaced.role}`);

  // ============================================
  // 8. Delete Documents (db.del)
  // ============================================
  console.log('\n8. Deleting documents...');

  await db.del.post(post.$ID, alice.$ID);
  await db.del.post(post2.$ID, bob.$ID);
  console.log('   Deleted posts');

  await db.del.user(charlie.$ID, 'SYSTEM');
  await db.del.user(bob.$ID, 'SYSTEM');
  await db.del.user(alice.$ID, 'SYSTEM');
  console.log('   Deleted users');

  // Verify deletion
  const remainingUsers = await db.get.userS();
  console.log(`   Remaining users: ${remainingUsers.length}`);

  // ============================================
  // 9. Graceful Shutdown
  // ============================================
  console.log('\n9. Disconnecting...');
  await db.disconnect();
  console.log('   Disconnected successfully');

  console.log('\n=== Example Complete ===');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
