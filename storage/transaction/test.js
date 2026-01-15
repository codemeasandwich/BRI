/**
 * Transaction Manager Tests
 *
 * Run with: node storage/transaction/test.js
 */

import { createDB } from '../../client/index.js';
import fs from 'fs/promises';

const TEST_DATA_DIR = './data-txn-test';

async function cleanup() {
  try {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (e) {}
}

async function runTests() {
  console.log('=== Transaction Manager Tests ===\n');

  await cleanup();

  const db = await createDB({
    storeConfig: {
      dataDir: TEST_DATA_DIR,
      maxMemoryMB: 64
    }
  });

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

  // ========== Test 1: Basic rec/fin flow ==========
  await test('Basic rec/fin flow', async () => {
    const txnId = db.rec();
    if (!txnId.startsWith('txn_')) throw new Error('txnId should start with txn_');

    // Add user in transaction
    const user = await db.add.user({ name: 'Alice' }, { txnId });
    if (!user.$ID) throw new Error('User should have $ID');

    // Verify NOT visible without txnId (use txnId: null to bypass active txn)
    const visibleUsers = await db.get.userS({ txnId: null });
    if (visibleUsers.length !== 0) throw new Error('User should NOT be visible without txnId');

    // Commit
    await db.fin(txnId);

    // Now visible
    const users = await db.get.userS({ txnId: null });
    if (users.length !== 1) throw new Error(`Expected 1 user, got ${users.length}`);
    if (users[0].name !== 'Alice') throw new Error('User name should be Alice');
  });

  // ========== Test 2: Isolation - txnId sees changes, others don't ==========
  await test('Isolation - only txnId sees changes', async () => {
    const txnId = db.rec();

    await db.add.pet({ name: 'Fluffy', type: 'cat' }, { txnId });

    // Without txnId - should NOT see the pet (use txnId: null to bypass)
    const noPets = await db.get.petS({ txnId: null });
    if (noPets.length !== 0) throw new Error('Pet should NOT be visible without txnId');

    // With txnId - SHOULD see the pet
    const hasPets = await db.get.petS({ txnId });
    if (hasPets.length !== 1) throw new Error('Pet SHOULD be visible with txnId');

    await db.fin(txnId);
  });

  // ========== Test 3: nop (cancel) discards changes ==========
  await test('nop (cancel) discards all changes', async () => {
    const txnId = db.rec();

    await db.add.temp({ data: 'should be discarded' }, { txnId });

    // Cancel transaction (clears _activeTxnId)
    await db.nop(txnId);

    // Should NOT exist (no active txn, so no txnId: null needed)
    const temps = await db.get.tempS();
    if (temps.length !== 0) throw new Error('Temp should be discarded after nop');
  });

  // ========== Test 4: pop (undo) removes last action ==========
  await test('pop (undo) removes last action', async () => {
    const txnId = db.rec();

    await db.add.item({ name: 'First' }, { txnId });
    await db.add.item({ name: 'Second' }, { txnId });

    // Both should be visible in txn (middleware auto-injects txnId)
    let items = await db.get.itemS();
    if (items.length !== 2) throw new Error(`Expected 2 items, got ${items.length}`);

    // Pop last action
    const popped = await db.pop(txnId);
    if (!popped) throw new Error('pop should return the popped action');

    // Now only First should be in txn
    items = await db.get.itemS();
    if (items.length !== 1) throw new Error(`Expected 1 item after pop, got ${items.length}`);
    if (items[0].name !== 'First') throw new Error('First item should remain');

    await db.fin(txnId);

    // Verify only First is committed (no active txn now)
    const finalItems = await db.get.itemS();
    if (finalItems.length !== 1) throw new Error(`Expected 1 item in store, got ${finalItems.length}`);
  });

  // ========== Test 5: Squashing multiple updates ==========
  await test('Squashing multiple updates to same document', async () => {
    const txnId = db.rec();

    const doc = await db.add.squash({ counter: 0 }, { txnId });
    const $ID = doc.$ID;

    // Multiple updates
    doc.counter = 1;
    await doc.save({ txnId });
    doc.counter = 2;
    await doc.save({ txnId });
    doc.counter = 3;
    await doc.save({ txnId });

    await db.fin(txnId);

    // Final value should be 3
    const result = await db.get.squash($ID);
    if (result.counter !== 3) throw new Error(`Expected counter=3, got ${result.counter}`);
  });

  // ========== Test 6: Transaction status ==========
  await test('txnStatus returns correct info', async () => {
    const txnId = db.rec();

    let status = db.txnStatus(txnId);
    if (!status.exists) throw new Error('Transaction should exist');
    if (status.actionCount !== 0) throw new Error('Should have 0 actions initially');

    await db.add.stat({ x: 1 }, { txnId });

    status = db.txnStatus(txnId);
    if (status.actionCount < 1) throw new Error('Should have at least 1 action');

    await db.nop(txnId);

    status = db.txnStatus(txnId);
    if (status.exists) throw new Error('Transaction should not exist after nop');
  });

  // ========== Test 7: Automatic txnId injection via middleware ==========
  await test('Middleware auto-injects txnId after rec()', async () => {
    // Start transaction - this sets db._activeTxnId
    db.rec();

    // Add WITHOUT explicit txnId - middleware should inject it
    const auto = await db.add.auto({ name: 'AutoInjected' });
    if (!auto.$ID) throw new Error('Should have $ID');

    // Should be visible in transaction (middleware injected txnId)
    const inTxn = await db.get.autoS();
    if (inTxn.length !== 1) throw new Error(`Expected 1 auto in txn, got ${inTxn.length}`);

    // Check that it's NOT visible when bypassing transaction
    const notInTxn = await db.get.autoS({ txnId: null });
    if (notInTxn.length !== 0) throw new Error('Should NOT be visible when bypassing txn');

    // Commit using default txnId
    await db.fin();

    // Now visible to all (no active txn)
    const visible = await db.get.autoS();
    if (visible.length !== 1) throw new Error('Should be visible after commit');
  });

  // ========== Test 8: fin/nop/pop without explicit txnId ==========
  await test('fin/nop/pop use active txnId when not specified', async () => {
    // Test nop without txnId
    db.rec();
    await db.add.noptest({ x: 1 });
    await db.nop(); // No txnId - uses _activeTxnId

    // After nop, _activeTxnId is cleared, so no bypass needed
    const afterNop = await db.get.noptestS();
    if (afterNop.length !== 0) throw new Error('Should be cancelled');

    // Test pop without txnId
    db.rec();
    await db.add.poptest({ name: 'First' });
    await db.add.poptest({ name: 'Second' });
    await db.pop(); // No txnId - uses _activeTxnId

    // Auto-inject txnId for txn view
    const afterPop = await db.get.poptestS();
    if (afterPop.length !== 1) throw new Error(`Expected 1 after pop, got ${afterPop.length}`);

    await db.fin(); // No txnId - uses _activeTxnId

    // After fin, _activeTxnId is cleared
    const final = await db.get.poptestS();
    if (final.length !== 1) throw new Error('Should have 1 after commit');
  });

  // ========== Test 9: Custom middleware plugin ==========
  await test('Custom middleware can intercept operations', async () => {
    let intercepted = [];

    // Add custom middleware
    const customMiddleware = async (ctx, next) => {
      intercepted.push({ op: ctx.operation, type: ctx.type });
      await next();
    };

    db.use(customMiddleware);

    await db.add.mwtest({ data: 'test' });

    if (intercepted.length === 0) throw new Error('Middleware should have been called');
    if (intercepted[0].op !== 'add') throw new Error('Should intercept add');
    if (intercepted[0].type !== 'mwtest') throw new Error('Should have correct type');

    // Clean up - remove middleware
    db.middleware.remove(customMiddleware);
  });

  // ========== Summary ==========
  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  await db.disconnect();
  await cleanup();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
