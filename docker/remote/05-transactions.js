/**
 * @file BRI Remote Examples: Transaction operations
 * Examples 14-17: Transactions - commit, rollback, undo, status
 */

import { section, subsection } from './helpers.js';

/**
 * Run transaction examples over remote connection
 * @param {Object} db - BRI remote database instance
 * @returns {Promise<void>}
 */
export async function runTransactionExamples(db) {
  // EXAMPLE 14: TRANSACTIONS - Basic commit flow
  section(14, 'TRANSACTIONS - Basic commit flow');

  subsection('Start transaction with db.rec()');
  const txnId = db.rec();
  console.log('  const txnId = db.rec()');
  console.log('  -> Transaction ID:', txnId);
  console.log('  -> db._activeTxnId:', db._activeTxnId);

  subsection('Operations within transaction');
  const order = await db.add.order({ items: ['item1', 'item2'], total: 99.99 }, { txnId });
  const payment = await db.add.payment({ amount: 99.99, orderId: order.$ID }, { txnId });
  console.log('  Created order:', order.$ID);
  console.log('  Created payment:', payment.$ID);

  subsection('Commit with db.fin()');
  const result = await db.fin(txnId);
  console.log('  await db.fin(txnId)');
  console.log('  -> Committed! Entries:', result.entries.length);

  const verifyOrder = await db.get.order(order.$ID);
  const verifyPayment = await db.get.payment(payment.$ID);
  console.log('  -> Order exists:', !!verifyOrder);
  console.log('  -> Payment exists:', !!verifyPayment);

  // EXAMPLE 15: TRANSACTIONS - Rollback flow
  section(15, 'TRANSACTIONS - Rollback flow');

  subsection('Start transaction');
  const txn2 = db.rec();
  console.log('  Transaction:', txn2);

  subsection('Create entities (not committed yet)');
  const badOrder = await db.add.order({ items: ['bad'], total: -100 }, { txnId: txn2 });
  console.log('  Created order:', badOrder.$ID, '(in txn only)');

  subsection('Rollback with db.nop()');
  await db.nop(txn2);
  console.log('  await db.nop(txnId) - transaction cancelled');

  subsection('Verify rollback');
  const shouldBeNull = await db.get.order(badOrder.$ID);
  console.log('  Order after rollback:', shouldBeNull);

  // EXAMPLE 16: TRANSACTIONS - Undo last action
  section(16, 'TRANSACTIONS - Undo last action');

  subsection('Start transaction');
  const txn3 = db.rec();

  subsection('Add multiple items');
  const item1 = await db.add.item({ name: 'Keep 1', price: 10 }, { txnId: txn3 });
  const item2 = await db.add.item({ name: 'Keep 2', price: 20 }, { txnId: txn3 });
  const item3 = await db.add.item({ name: 'Remove Me', price: 30 }, { txnId: txn3 });
  console.log('  Added 3 items to transaction');

  subsection('Check transaction status');
  let status = db.txnStatus(txn3);
  console.log('  db.txnStatus():', status.actionCount, 'actions');

  subsection('Undo last action with db.pop()');
  const undone = await db.pop(txn3);
  console.log('  await db.pop(txnId)');
  console.log('  -> Undone:', undone?.action, 'on', undone?.target);

  status = db.txnStatus(txn3);
  console.log('  -> Actions remaining:', status.actionCount);

  subsection('Commit remaining actions');
  await db.fin(txn3);

  const keepItem1 = await db.get.item(item1.$ID);
  const keepItem2 = await db.get.item(item2.$ID);
  const removedItem = await db.get.item(item3.$ID);
  console.log('  Item 1 exists:', !!keepItem1);
  console.log('  Item 2 exists:', !!keepItem2);
  console.log('  Item 3 exists (undone):', !!removedItem);

  // EXAMPLE 17: TRANSACTIONS - Status checking
  section(17, 'TRANSACTIONS - Status checking');

  subsection('Start transaction');
  const txn4 = db.rec();

  subsection('Check initial status');
  let txnStatus = db.txnStatus(txn4);
  console.log('  db.txnStatus(txnId):');
  console.log('  -> txnId:', txnStatus.txnId);
  console.log('  -> status:', txnStatus.status);
  console.log('  -> actionCount:', txnStatus.actionCount);
  console.log('  -> createdAt:', txnStatus.createdAt);

  subsection('Add actions and check again');
  await db.add.log({ message: 'Log 1' }, { txnId: txn4 });
  await db.add.log({ message: 'Log 2' }, { txnId: txn4 });

  txnStatus = db.txnStatus(txn4);
  console.log('  After 2 actions:');
  console.log('  -> actionCount:', txnStatus.actionCount);

  subsection('Commit and check final status');
  await db.fin(txn4);
  txnStatus = db.txnStatus(txn4);
  console.log('  After commit:');
  console.log('  -> status:', txnStatus.status);
}
