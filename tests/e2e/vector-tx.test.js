/**
 * @file UC-V4 acceptance tests — vector index transaction integration
 *
 * Acceptance criteria from the Vector + Graph spec, §4 UC-V4:
 *   - staged write visible inside txn only
 *   - read consistent inside txn (sees own writes immediately)
 *   - read consistent outside txn (sees committed-only state until fin)
 *   - nop leaves index pristine
 *   - pop undoes the last vector write
 *   - crash recovery to pre-txn state
 *
 * These tests gate the txn-isolation contract for vector data. Without them,
 * a regression that leaks a staged write to outside-txn searches (or fails
 * to roll back on nop) would silently corrupt observable state.
 *
 * @implements UC-V4
 */
import { jest } from '@jest/globals';
import { createDB } from '../../client/index.js';
import fs from 'fs/promises';

const DIR = './test-data-vector-tx';
const DIMS = 4;

function makeVec(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const v = new Array(DIMS);
  let mag = 0;
  for (let i = 0; i < DIMS; i++) {
    h = (h * 1103515245 + 12345) | 0;
    v[i] = ((h >>> 0) % 1000) / 1000 - 0.5;
    mag += v[i] * v[i];
  }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= mag;
  return v;
}

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  const db = await createDB({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
  db.schema('memoryArtifact', {
    type: { type: String, required: true },
    embedding: { type: 'vector', dims: DIMS, required: false },
  });
  return db;
}

describe('UC-V4: Vector transaction isolation', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('staged write is invisible to searches outside the open txn', async () => {
    db = await freshDB();
    // First commit a baseline doc (outside any txn).
    const baseVec = makeVec('outside-baseline');
    const base = await db.add.memoryArtifact({ type: 'fact', embedding: baseVec });

    // Now open a txn and add a doc with a SIMILAR vector to the staged one.
    db.rec();
    const stagedVec = makeVec('staged');
    const staged = await db.add.memoryArtifact({ type: 'fact', embedding: stagedVec });

    // Outside the txn — passing txnId: null bypasses active txn injection.
    // The staged doc must NOT appear.
    const outsideHits = await db.get.memoryArtifactS.near(stagedVec, 5, { txnId: null });
    const outsideIds = outsideHits.map(h => h.$ID);
    expect(outsideIds).toContain(base.$ID);
    expect(outsideIds).not.toContain(staged.$ID);

    await db.nop();
  });

  test('staged write IS visible to searches inside the txn', async () => {
    db = await freshDB();
    db.rec();
    const v = makeVec('in-txn-visible');
    const inTxn = await db.add.memoryArtifact({ type: 'fact', embedding: v });

    // Active txn auto-injects txnId; this query happens INSIDE the txn.
    const hits = await db.get.memoryArtifactS.near(v, 1);
    expect(hits.map(h => h.$ID)).toContain(inTxn.$ID);

    await db.nop();
  });

  test('nop leaves the index pristine — no staged entry survives', async () => {
    db = await freshDB();
    const baseVec = makeVec('nop-baseline');
    const base = await db.add.memoryArtifact({ type: 'fact', embedding: baseVec });

    db.rec();
    const cancelledVec = makeVec('nop-cancelled');
    const cancelled = await db.add.memoryArtifact({ type: 'fact', embedding: cancelledVec });
    await db.nop();

    // Post-nop search must not return the cancelled doc, AND the index
    // entry for that doc must be gone (search by its own vector).
    const all = await db.get.memoryArtifactS.near(cancelledVec, 10);
    const ids = all.map(h => h.$ID);
    expect(ids).not.toContain(cancelled.$ID);
    expect(ids).toContain(base.$ID);
  });

  test('fin commits all staged writes atomically', async () => {
    db = await freshDB();
    db.rec();
    const v1 = makeVec('fin-1');
    const v2 = makeVec('fin-2');
    const a = await db.add.memoryArtifact({ type: 'fact', embedding: v1 });
    const b = await db.add.memoryArtifact({ type: 'fact', embedding: v2 });
    await db.fin();

    // Outside txn now — both must be searchable.
    const [hit1] = await db.get.memoryArtifactS.near(v1, 1, { txnId: null });
    const [hit2] = await db.get.memoryArtifactS.near(v2, 1, { txnId: null });
    expect(hit1.$ID).toBe(a.$ID);
    expect(hit2.$ID).toBe(b.$ID);
  });

  test('pop undoes the last vector write within a txn', async () => {
    db = await freshDB();
    db.rec();
    const v1 = makeVec('pop-keep');
    const v2 = makeVec('pop-discard');
    const keep = await db.add.memoryArtifact({ type: 'fact', embedding: v1 });
    const discard = await db.add.memoryArtifact({ type: 'fact', embedding: v2 });

    // Bri's pop() undoes a single action; a single db.add records two actions
    // in the txn (SET for the doc body + SADD for collection membership).
    // To fully undo the discard add, pop twice — the second pop targets the
    // SET, which is the action our vector-aware hook keys off of.
    await db.pop();
    await db.pop();

    // Inside-txn search for v2 must NOT find discard anymore.
    const v2hits = await db.get.memoryArtifactS.near(v2, 5);
    expect(v2hits.map(h => h.$ID)).not.toContain(discard.$ID);

    // But v1 (keep) is still staged.
    const v1hits = await db.get.memoryArtifactS.near(v1, 1);
    expect(v1hits.map(h => h.$ID)).toContain(keep.$ID);

    await db.fin();

    // After fin, only keep is committed.
    const finalHits = await db.get.memoryArtifactS.near(v1, 5, { txnId: null });
    const finalIds = finalHits.map(h => h.$ID);
    expect(finalIds).toContain(keep.$ID);
    expect(finalIds).not.toContain(discard.$ID);
  });

  test('vector index middleware stages delete removal while txn open (removeStaged path)', async () => {
    db = await freshDB();
    const v = makeVec('del-staged-vec');
    const doc = await db.add.memoryArtifact({ type: 'fact', embedding: v });
    db.rec();
    await db.del.memoryArtifact(doc.$ID);
    // Outside the committed slot: near must not resolve the staged-deleted id.
    const scoped = await db.get.memoryArtifactS.near(v, 5, { txnId: null });
    expect(scoped.some((h) => h.$ID === doc.$ID)).toBe(false);
    await db.nop();
  });

  test('crash mid-txn recovers to pre-txn state', async () => {
    db = await freshDB();
    const baseVec = makeVec('crash-base');
    const base = await db.add.memoryArtifact({ type: 'fact', embedding: baseVec });
    await db._store.createSnapshot();
    // Open a txn, add staged data, then "crash" (disconnect WITHOUT fin/nop).
    db.rec();
    const stagedVec = makeVec('crash-staged');
    await db.add.memoryArtifact({ type: 'fact', embedding: stagedVec });
    // Force-disconnect: per the existing TransactionManager, in-flight txns
    // don't auto-commit on disconnect. Their .wal files remain in txn dir.
    await db.disconnect();

    // Reboot.
    db = await createDB({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      embedding: { type: 'vector', dims: DIMS, required: false },
    });

    // The staged doc must NOT be searchable; only the pre-txn baseline doc is.
    const hits = await db.get.memoryArtifactS.near(stagedVec, 10);
    const ids = hits.map(h => h.$ID);
    expect(ids).toContain(base.$ID);
    // Staged $IDs are MECT_ prefixed but were generated mid-txn; we don't
    // know the exact $ID, but we DO know the staged doc isn't there.
    expect(hits.length).toBe(1);
  });
});
