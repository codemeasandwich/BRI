/**
 * BRI Store Test Suite
 *
 * Run with: node store/test.js
 */

const { createStore } = require('./index.js');
const fs = require('fs').promises;
const path = require('path');

const TEST_DATA_DIR = './test-data';

async function cleanup() {
  try {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (err) {
    // Ignore if doesn't exist
  }
}

async function runTests() {
  console.log('='.repeat(50));
  console.log('BRI Store Test Suite');
  console.log('='.repeat(50));

  await cleanup();

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${err.message}`);
      failed++;
    }
  }

  // Create store
  const store = await createStore({
    type: 'inhouse',
    config: {
      dataDir: TEST_DATA_DIR,
      maxMemoryMB: 64,
      snapshotIntervalMs: 60000 // 1 minute for testing
    }
  });

  console.log('\n--- Basic Operations ---\n');

  await test('set and get a value', async () => {
    await store.set('US_test001', '{"$ID":"US_test001","name":"Alice"}');
    const result = await store.get('US_test001');
    const data = JSON.parse(result);
    if (data.name !== 'Alice') throw new Error('Name mismatch');
  });

  await test('get non-existent key returns null', async () => {
    const result = await store.get('US_nonexistent');
    if (result !== null) throw new Error('Expected null');
  });

  await test('overwrite existing value', async () => {
    await store.set('US_test001', '{"$ID":"US_test001","name":"Bob"}');
    const result = await store.get('US_test001');
    const data = JSON.parse(result);
    if (data.name !== 'Bob') throw new Error('Name should be Bob');
  });

  console.log('\n--- Set Operations ---\n');

  await test('sAdd and sMembers', async () => {
    await store.sAdd('US?', 'abc123');
    await store.sAdd('US?', 'def456');
    const members = await store.sMembers('US?');
    if (!members.includes('abc123')) throw new Error('Missing abc123');
    if (!members.includes('def456')) throw new Error('Missing def456');
  });

  await test('sRem removes member', async () => {
    await store.sRem('US?', 'abc123');
    const members = await store.sMembers('US?');
    if (members.includes('abc123')) throw new Error('abc123 should be removed');
    if (!members.includes('def456')) throw new Error('def456 should remain');
  });

  await test('sMembers on empty set returns empty array', async () => {
    const members = await store.sMembers('EMPTY?');
    if (!Array.isArray(members) || members.length !== 0) {
      throw new Error('Expected empty array');
    }
  });

  console.log('\n--- Rename (Soft Delete) ---\n');

  await test('rename key', async () => {
    await store.set('US_todelete', '{"$ID":"US_todelete","name":"Delete Me"}');
    await store.rename('US_todelete', 'X:US_todelete:X');

    const oldResult = await store.get('US_todelete');
    if (oldResult !== null) throw new Error('Old key should not exist');

    const newResult = await store.get('X:US_todelete:X');
    if (newResult === null) throw new Error('New key should exist');
  });

  console.log('\n--- Pub/Sub ---\n');

  await test('publish and subscribe', async () => {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for message'));
      }, 1000);

      await store.subscribe('TEST', (message) => {
        clearTimeout(timeout);
        const data = JSON.parse(message);
        if (data.hello === 'world') {
          resolve();
        } else {
          reject(new Error('Wrong message'));
        }
      });

      await store.publish('TEST', JSON.stringify({ hello: 'world' }));
    });
  });

  console.log('\n--- Persistence ---\n');

  await test('data persists after disconnect/reconnect', async () => {
    // Set some data
    await store.set('US_persist', '{"$ID":"US_persist","value":"persistent"}');

    // Create snapshot
    await store.createSnapshot();

    // Disconnect
    await store.disconnect();

    // Create new store instance
    const store2 = await createStore({
      type: 'inhouse',
      config: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64
      }
    });

    // Check data exists
    const result = await store2.get('US_persist');
    if (!result) throw new Error('Data should persist');

    const data = JSON.parse(result);
    if (data.value !== 'persistent') throw new Error('Value mismatch');

    await store2.disconnect();
  });

  console.log('\n--- Stats ---\n');

  const store3 = await createStore({
    type: 'inhouse',
    config: {
      dataDir: TEST_DATA_DIR,
      maxMemoryMB: 64
    }
  });

  const stats = await store3.getStats();
  console.log('Store Stats:', JSON.stringify(stats, null, 2));

  await store3.disconnect();

  // Cleanup
  await cleanup();

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
