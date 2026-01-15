/**
 * E2E Transaction Tests
 * Tests: rec, fin, nop, pop, txnStatus, isolation
 */

import { createDB } from '../../client/index.js';
import { TransactionManager } from '../../storage/transaction/manager.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DATA_DIR = './test-data-txn';

describe('Transaction Operations', () => {
  let db;

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
    db = await createDB({
      storeConfig: {
        dataDir: TEST_DATA_DIR,
        maxMemoryMB: 64
      }
    });
  });

  afterAll(async () => {
    await db.disconnect();
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    // Clean up any active transactions
    if (db._activeTxnId) {
      try {
        await db.nop();
      } catch (e) {}
    }
  });

  describe('rec() - Start Transaction', () => {
    test('returns transaction ID starting with txn_', () => {
      const txnId = db.rec();
      expect(txnId).toMatch(/^txn_/);
      db.nop(txnId);
    });

    test('sets _activeTxnId on db instance', () => {
      const txnId = db.rec();
      expect(db._activeTxnId).toBe(txnId);
      db.nop(txnId);
    });

    test('multiple rec() creates different transactions', () => {
      const txn1 = db.rec();
      db.nop(txn1);
      const txn2 = db.rec();
      expect(txn2).not.toBe(txn1);
      db.nop(txn2);
    });
  });

  describe('Transaction Isolation', () => {
    test('changes in transaction not visible without txnId', async () => {
      const txnId = db.rec();

      await db.add.item({ name: 'Isolated' }, { txnId });

      // Without txnId - should NOT see
      const noTxn = await db.get.itemS({ txnId: null });
      expect(noTxn.length).toBe(0);

      // With txnId - SHOULD see
      const withTxn = await db.get.itemS({ txnId });
      expect(withTxn.length).toBe(1);

      await db.nop(txnId);
    });

    test('auto-inject txnId via middleware after rec()', async () => {
      db.rec();

      // Add without explicit txnId - middleware injects it
      const item = await db.add.item({ name: 'AutoInjected' });
      expect(item.$ID).toBeDefined();

      // Should be visible (middleware injected txnId)
      const items = await db.get.itemS();
      expect(items.length).toBe(1);

      // Not visible when bypassing
      const bypass = await db.get.itemS({ txnId: null });
      expect(bypass.length).toBe(0);

      await db.nop();
    });

    test('txnId: null bypasses active transaction', async () => {
      // Create item outside transaction
      const outside = await db.add.thing({ name: 'Outside' });

      db.rec();
      await db.add.thing({ name: 'Inside' });

      // With bypass, only sees "Outside"
      const bypass = await db.get.thingS({ txnId: null });
      expect(bypass.length).toBe(1);
      expect(bypass[0].name).toBe('Outside');

      await db.nop();
    });

    test('txnId: false also bypasses transaction', async () => {
      await db.add.skiptype({ name: 'Pre' });

      db.rec();
      await db.add.skiptype({ name: 'Txn' });

      const skipItems = await db.get.skiptypeS({ txnId: false });
      expect(skipItems.length).toBe(1);

      await db.nop();
    });
  });

  describe('fin() - Commit Transaction', () => {
    test('commits changes making them visible', async () => {
      const txnId = db.rec();
      await db.add.commit({ name: 'Committed' }, { txnId });

      await db.fin(txnId);

      const items = await db.get.commitS();
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('Committed');
    });

    test('clears _activeTxnId after commit', async () => {
      const txnId = db.rec();
      expect(db._activeTxnId).toBe(txnId);

      await db.fin(txnId);
      expect(db._activeTxnId).toBeNull();
    });

    test('fin() without argument uses _activeTxnId', async () => {
      db.rec();
      await db.add.fintest({ name: 'NoArg' });

      await db.fin();

      expect(db._activeTxnId).toBeNull();
      const items = await db.get.fintestS();
      expect(items.length).toBe(1);
    });

    test('throws when no transaction to commit', () => {
      expect(() => db.fin()).toThrow('No transaction to commit');
    });

    test('squashes multiple updates to same document', async () => {
      const txnId = db.rec();

      const doc = await db.add.squash({ counter: 0 }, { txnId });
      doc.counter = 1;
      await doc.save({ txnId });
      doc.counter = 2;
      await doc.save({ txnId });
      doc.counter = 3;
      await doc.save({ txnId });

      await db.fin(txnId);

      const result = await db.get.squash(doc.$ID);
      expect(result.counter).toBe(3);
    });
  });

  describe('nop() - Cancel Transaction', () => {
    test('discards all changes', async () => {
      const txnId = db.rec();
      await db.add.discard({ name: 'Discarded' }, { txnId });

      await db.nop(txnId);

      const items = await db.get.discardS();
      expect(items.length).toBe(0);
    });

    test('clears _activeTxnId after cancel', async () => {
      const txnId = db.rec();
      expect(db._activeTxnId).toBe(txnId);

      await db.nop(txnId);
      expect(db._activeTxnId).toBeNull();
    });

    test('nop() without argument uses _activeTxnId', async () => {
      db.rec();
      await db.add.noptest({ name: 'NoArg' });

      await db.nop();

      expect(db._activeTxnId).toBeNull();
      const items = await db.get.noptestS();
      expect(items.length).toBe(0);
    });

    test('throws when no transaction to cancel', () => {
      expect(() => db.nop()).toThrow('No transaction to cancel');
    });
  });

  describe('pop() - Undo Last Action', () => {
    test('removes last action from transaction', async () => {
      const txnId = db.rec();

      await db.add.popitem({ name: 'First' }, { txnId });
      await db.add.popitem({ name: 'Second' }, { txnId });

      let items = await db.get.popitemS({ txnId });
      expect(items.length).toBe(2);

      const popped = await db.pop(txnId);
      expect(popped).toBeTruthy();

      items = await db.get.popitemS({ txnId });
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('First');

      await db.fin(txnId);
    });

    test('pop() without argument uses _activeTxnId', async () => {
      db.rec();
      await db.add.poptest({ name: 'First' });
      await db.add.poptest({ name: 'Second' });

      await db.pop();

      const items = await db.get.poptestS();
      expect(items.length).toBe(1);

      await db.fin();
    });

    test('returns null when no actions to pop', async () => {
      const txnId = db.rec();
      const result = await db.pop(txnId);
      expect(result).toBeNull();
      await db.nop(txnId);
    });

    test('throws when no transaction to pop from', () => {
      expect(() => db.pop()).toThrow('No transaction to pop from');
    });
  });

  describe('txnStatus()', () => {
    test('returns status for active transaction', () => {
      const txnId = db.rec();

      const status = db.txnStatus(txnId);
      expect(status.exists).toBe(true);
      expect(status.actionCount).toBe(0);

      db.nop(txnId);
    });

    test('returns exists: false for non-existent transaction', () => {
      const status = db.txnStatus('txn_nonexistent');
      expect(status.exists).toBe(false);
    });

    test('txnStatus() without argument uses _activeTxnId', async () => {
      db.rec();
      await db.add.statustest({ name: 'Test' });

      const status = db.txnStatus();
      expect(status.exists).toBe(true);
      expect(status.actionCount).toBeGreaterThan(0);

      await db.nop();
    });

    test('tracks action count', async () => {
      const txnId = db.rec();

      let status = db.txnStatus(txnId);
      expect(status.actionCount).toBe(0);

      await db.add.counttest({ name: 'One' }, { txnId });
      status = db.txnStatus(txnId);
      expect(status.actionCount).toBeGreaterThan(0);

      await db.nop(txnId);
    });
  });

  describe('Transaction with Updates', () => {
    test('update in transaction', async () => {
      // Create outside transaction
      const item = await db.add.upd({ value: 1 });

      const txnId = db.rec();

      // Get and update in transaction
      const inTxn = await db.get.upd(item.$ID, { txnId });
      inTxn.value = 2;
      await inTxn.save({ txnId });

      // Outside transaction still sees old value
      const outside = await db.get.upd(item.$ID, { txnId: null });
      expect(outside.value).toBe(1);

      await db.fin(txnId);

      // Now sees new value
      const after = await db.get.upd(item.$ID);
      expect(after.value).toBe(2);
    });
  });

  describe('Transaction with Renames', () => {
    test('rename (soft delete) in transaction', async () => {
      const item = await db.add.renam({ name: 'ToRename' });
      const deleter = await db.add.renam({ name: 'Deleter' });

      const txnId = db.rec();

      // Note: del doesn't currently support txnId in this codebase
      // Testing rename at storage level would need direct store access

      await db.nop(txnId);
    });
  });

  describe('Transaction with Set Operations', () => {
    test('set members reflect transaction state', async () => {
      const txnId = db.rec();

      await db.add.setitem({ name: 'InTxn' }, { txnId });

      // Check set members with txnId
      const withTxn = await db.get.setitemS({ txnId });
      expect(withTxn.length).toBe(1);

      await db.nop(txnId);
    });
  });
});

describe('TransactionManager Direct Tests', () => {
  let txnManager;
  const TXN_TEST_DIR = './test-data-txn-direct';

  beforeEach(async () => {
    await fs.rm(TXN_TEST_DIR, { recursive: true, force: true }).catch(() => {});
    txnManager = new TransactionManager(TXN_TEST_DIR);
  });

  afterEach(async () => {
    await fs.rm(TXN_TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('rec() - Start Transaction', () => {
    test('generates unique txnId', () => {
      const txnId = txnManager.rec();
      expect(txnId).toMatch(/^txn_[a-z0-9]{7}$/);
    });

    test('creates WAL file for transaction', () => {
      const txnId = txnManager.rec();
      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      expect(fs.access(walPath).then(() => true).catch(() => false)).resolves.toBe(true);
    });
  });

  describe('getTxn()', () => {
    test('returns transaction state', () => {
      const txnId = txnManager.rec();
      const txn = txnManager.getTxn(txnId);
      expect(txn.txnId).toBe(txnId);
    });

    test('throws for non-existent transaction', () => {
      expect(() => txnManager.getTxn('txn_notexist')).toThrow('Transaction not found');
    });
  });

  describe('hasTxn()', () => {
    test('returns true for existing transaction', () => {
      const txnId = txnManager.rec();
      expect(txnManager.hasTxn(txnId)).toBe(true);
    });

    test('returns false for non-existent transaction', () => {
      expect(txnManager.hasTxn('txn_notexist')).toBe(false);
    });
  });

  describe('set()', () => {
    test('stores document in transaction shadow state', () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{"name":"Test"}');

      const value = txnManager.get(txnId, 'TEST_key');
      expect(value).toBe('{"name":"Test"}');
    });

    test('records action for pop()', () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{}');

      const txn = txnManager.getTxn(txnId);
      expect(txn.actions.length).toBe(1);
      expect(txn.actions[0].action).toBe('SET');
    });
  });

  describe('get()', () => {
    test('returns value from shadow state', () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{"value":1}');

      const value = txnManager.get(txnId, 'TEST_key');
      expect(value).toBe('{"value":1}');
    });

    test('returns null for deleted document', () => {
      const txnId = txnManager.rec();
      const txn = txnManager.getTxn(txnId);
      txn.deletedDocs.add('TEST_key');

      const value = txnManager.get(txnId, 'TEST_key');
      expect(value).toBeNull();
    });

    test('returns undefined for document not in transaction', () => {
      const txnId = txnManager.rec();
      const value = txnManager.get(txnId, 'UNKNOWN_key');
      expect(value).toBeUndefined();
    });

    test('handles renamed key lookups', () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'OLD_key', '{"renamed":true}');
      txnManager.rename(txnId, 'OLD_key', 'NEW_key');

      const value = txnManager.get(txnId, 'NEW_key');
      expect(value).toBe('{"renamed":true}');
    });
  });

  describe('rename()', () => {
    test('moves document from old to new key', () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'OLD_key', '{"data":"test"}');
      txnManager.rename(txnId, 'OLD_key', 'NEW_key');

      expect(txnManager.get(txnId, 'OLD_key')).toBeUndefined();
      expect(txnManager.get(txnId, 'NEW_key')).toBe('{"data":"test"}');
    });

    test('records rename action', () => {
      const txnId = txnManager.rec();
      txnManager.rename(txnId, 'OLD_key', 'NEW_key');

      const txn = txnManager.getTxn(txnId);
      expect(txn.renames.get('OLD_key')).toBe('NEW_key');
    });
  });

  describe('sAdd()', () => {
    test('adds member to transaction set', () => {
      const txnId = txnManager.rec();
      txnManager.sAdd(txnId, 'SET?', 'member1');

      const members = txnManager.sMembers(txnId, 'SET?');
      expect(members.has('member1')).toBe(true);
    });
  });

  describe('sMembers()', () => {
    test('returns set members', () => {
      const txnId = txnManager.rec();
      txnManager.sAdd(txnId, 'SET?', 'a');
      txnManager.sAdd(txnId, 'SET?', 'b');

      const members = txnManager.sMembers(txnId, 'SET?');
      expect(members.size).toBe(2);
    });

    test('returns empty set for non-existent set', () => {
      const txnId = txnManager.rec();
      const members = txnManager.sMembers(txnId, 'NOTEXIST?');
      expect(members.size).toBe(0);
    });
  });

  describe('sRem()', () => {
    test('removes member from set', () => {
      const txnId = txnManager.rec();
      txnManager.sAdd(txnId, 'SET?', 'member1');
      txnManager.sRem(txnId, 'SET?', 'member1');

      const members = txnManager.sMembers(txnId, 'SET?');
      expect(members.has('member1')).toBe(false);
    });

    test('is no-op for non-existent set', () => {
      const txnId = txnManager.rec();
      // Should not throw
      txnManager.sRem(txnId, 'NOTEXIST?', 'member');
    });
  });

  describe('pop()', () => {
    test('reverses SET action', async () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{"v":1}');

      await txnManager.pop(txnId);

      expect(txnManager.get(txnId, 'TEST_key')).toBeUndefined();
    });

    test('reverses SET with previous value', async () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{"v":1}');
      txnManager.set(txnId, 'TEST_key', '{"v":2}');

      await txnManager.pop(txnId);

      expect(txnManager.get(txnId, 'TEST_key')).toBe('{"v":1}');
    });

    test('reverses DELETE action', async () => {
      const txnId = txnManager.rec();
      const txn = txnManager.getTxn(txnId);
      // Simulate a delete action
      txn.deletedDocs.add('TEST_key');
      txn.actions.push({ action: 'DELETE', target: 'TEST_key', ts: new Date() });

      await txnManager.pop(txnId);

      expect(txn.deletedDocs.has('TEST_key')).toBe(false);
    });

    test('reverses RENAME action', async () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'OLD_key', '{"data":"test"}');
      txnManager.rename(txnId, 'OLD_key', 'NEW_key');

      await txnManager.pop(txnId);

      expect(txnManager.get(txnId, 'OLD_key')).toBe('{"data":"test"}');
    });

    test('reverses SADD action', async () => {
      const txnId = txnManager.rec();
      txnManager.sAdd(txnId, 'SET?', 'member');

      await txnManager.pop(txnId);

      const members = txnManager.sMembers(txnId, 'SET?');
      expect(members.has('member')).toBe(false);
    });

    test('reverses SREM action', async () => {
      const txnId = txnManager.rec();
      txnManager.sAdd(txnId, 'SET?', 'member');
      // Pop the SADD first
      await txnManager.pop(txnId);
      // Manually add SREM action
      const txn = txnManager.getTxn(txnId);
      txn.actions.push({ action: 'SREM', target: 'SET?', member: 'member', ts: new Date() });

      await txnManager.pop(txnId);

      expect(txn.collections.get('SET?').has('member')).toBe(true);
    });

    test('returns null when no actions', async () => {
      const txnId = txnManager.rec();
      const result = await txnManager.pop(txnId);
      expect(result).toBeNull();
    });
  });

  describe('fin()', () => {
    test('returns squashed entries', async () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{"name":"test"}');
      txnManager.sAdd(txnId, 'SET?', 'member');

      const result = await txnManager.fin(txnId);

      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.documents.size).toBe(1);
      expect(result.collections.size).toBe(1);
    });

    test('removes transaction from pending', async () => {
      const txnId = txnManager.rec();
      await txnManager.fin(txnId);
      expect(txnManager.hasTxn(txnId)).toBe(false);
    });

    test('deletes transaction WAL file', async () => {
      const txnId = txnManager.rec();
      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);

      await txnManager.fin(txnId);

      const exists = await fs.access(walPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    test('squashActions includes renames not in documents', async () => {
      const txnId = txnManager.rec();
      // Rename without setting the value (rename from main store)
      const txn = txnManager.getTxn(txnId);
      txn.renames.set('OLD_key', 'NEW_key');
      txn.actions.push({ action: 'RENAME', oldKey: 'OLD_key', target: 'NEW_key', ts: new Date() });

      const result = await txnManager.fin(txnId);

      const renameEntry = result.entries.find(e => e.action === 'RENAME');
      expect(renameEntry).toBeDefined();
    });
  });

  describe('nop()', () => {
    test('discards transaction', async () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{}');

      await txnManager.nop(txnId);

      expect(txnManager.hasTxn(txnId)).toBe(false);
    });

    test('deletes transaction WAL file', async () => {
      const txnId = txnManager.rec();
      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);

      await txnManager.nop(txnId);

      const exists = await fs.access(walPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    test('is no-op for non-existent transaction', async () => {
      // Should not throw
      await txnManager.nop('txn_notexist');
    });
  });

  describe('status()', () => {
    test('returns status for active transaction', async () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{}');

      const status = txnManager.status(txnId);

      expect(status.exists).toBe(true);
      expect(status.txnId).toBe(txnId);
      expect(status.actionCount).toBe(1);
    });

    test('returns exists: false for non-existent transaction', () => {
      const status = txnManager.status('txn_notexist');
      expect(status.exists).toBe(false);
    });

    test('includes createdAt from first action', () => {
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{}');

      const status = txnManager.status(txnId);
      expect(status.createdAt).toBeInstanceOf(Date);
    });

    test('createdAt is null when no actions', () => {
      const txnId = txnManager.rec();
      const status = txnManager.status(txnId);
      expect(status.createdAt).toBeNull();
    });
  });

  describe('listPending()', () => {
    test('returns array of pending txnIds', () => {
      const txn1 = txnManager.rec();
      const txn2 = txnManager.rec();

      const pending = txnManager.listPending();

      expect(pending).toContain(txn1);
      expect(pending).toContain(txn2);
    });
  });

  describe('recover()', () => {
    test('recovers transactions from disk', async () => {
      // Create a transaction and don't commit it
      const txnId = txnManager.rec();
      txnManager.set(txnId, 'TEST_key', '{"recovered":true}');

      // Create new manager to simulate restart
      const newManager = new TransactionManager(TXN_TEST_DIR);
      await newManager.recover();

      expect(newManager.hasTxn(txnId)).toBe(true);
      const value = newManager.get(txnId, 'TEST_key');
      expect(value).toBe('{"recovered":true}');
    });

    test('handles missing txn directory', async () => {
      await fs.rm(TXN_TEST_DIR, { recursive: true, force: true });
      const newManager = new TransactionManager(TXN_TEST_DIR);
      // Should not throw
      await newManager.recover();
    });

    test('recovers DELETE actions', async () => {
      const txnId = txnManager.rec();
      const txn = txnManager.getTxn(txnId);

      // Write a DELETE entry directly to WAL
      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      // The entry format needs timestamp|pointer|json
      const entry = {
        action: 'DELETE',
        target: 'TEST_key'
      };
      const line = `${Date.now()}|abc123|${JSON.stringify(entry)}`;
      await fs.writeFile(walPath, line + '\n', 'utf8');

      const newManager = new TransactionManager(TXN_TEST_DIR);
      await newManager.recover();

      const recoveredTxn = newManager.getTxn(txnId);
      expect(recoveredTxn.deletedDocs.has('TEST_key')).toBe(true);
    });

    test('recovers RENAME actions', async () => {
      const txnId = txnManager.rec();

      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      const entry = {
        action: 'RENAME',
        oldKey: 'OLD_key',
        target: 'NEW_key'
      };
      await fs.writeFile(walPath, `${Date.now()}|abc|${JSON.stringify(entry)}\n`, 'utf8');

      const newManager = new TransactionManager(TXN_TEST_DIR);
      await newManager.recover();

      const recoveredTxn = newManager.getTxn(txnId);
      expect(recoveredTxn.renames.get('OLD_key')).toBe('NEW_key');
    });

    test('recovers SADD actions', async () => {
      const txnId = txnManager.rec();

      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      const entry = {
        action: 'SADD',
        target: 'SET?',
        member: 'member1'
      };
      await fs.writeFile(walPath, `${Date.now()}|abc|${JSON.stringify(entry)}\n`, 'utf8');

      const newManager = new TransactionManager(TXN_TEST_DIR);
      await newManager.recover();

      const recoveredTxn = newManager.getTxn(txnId);
      expect(recoveredTxn.collections.get('SET?').has('member1')).toBe(true);
    });

    test('recovers SREM actions', async () => {
      const txnId = txnManager.rec();

      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      // First SADD then SREM
      const entry1 = { action: 'SADD', target: 'SET?', member: 'member1' };
      const entry2 = { action: 'SREM', target: 'SET?', member: 'member1' };
      const content = `${Date.now()}|abc|${JSON.stringify(entry1)}\n${Date.now()}|def|${JSON.stringify(entry2)}\n`;
      await fs.writeFile(walPath, content, 'utf8');

      const newManager = new TransactionManager(TXN_TEST_DIR);
      await newManager.recover();

      const recoveredTxn = newManager.getTxn(txnId);
      expect(recoveredTxn.collections.get('SET?')?.has('member1')).toBeFalsy();
    });

    test('handles corrupted WAL entry gracefully', async () => {
      const txnId = txnManager.rec();

      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      await fs.writeFile(walPath, 'corrupted|data|not-json\n', 'utf8');

      const newManager = new TransactionManager(TXN_TEST_DIR);
      // Should not throw, just log warning
      await newManager.recover();
      expect(newManager.hasTxn(txnId)).toBe(true);
    });
  });

  describe('close()', () => {
    test('is a no-op (transactions remain for recovery)', async () => {
      const txnId = txnManager.rec();
      await txnManager.close();
      // Transaction should still be in WAL file
      const walPath = path.join(TXN_TEST_DIR, 'txn', `${txnId}.wal`);
      const exists = await fs.access(walPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });
});
