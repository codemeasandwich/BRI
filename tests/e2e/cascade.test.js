/**
 * @file UC-X2 acceptance tests — schema-scoped cancellation cascade
 *
 * Acceptance criteria (spec §4 UC-X2):
 *   - cascade_session_deletes_marked_collections — collections that
 *     declare a field with `cascadeOn: 'session'` get scoped deletes
 *   - knowledge_collections_immune — collections without the flag are
 *     untouched
 *   - in_flight_other_session_txn_protected — another session's open
 *     transaction is unaffected
 *   - cascade_idempotent — re-running cascade is a no-op
 *
 * The "cancelled session's txn rolled back" criterion is verified at the
 * caller-composition level (db.nop() + db.cascade.session) rather than
 * inside cascade itself, because session→txnId mapping is application-
 * level state. That composition pattern is exercised via the V4 nop test
 * suite + this cascade suite together.
 *
 * Cascade is a §10 NON-NEGOTIABLE — the V8 spec marks the cancellation
 * cascade as one of two invariants that absolutely must work.
 *
 * @implements UC-X2
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import fs from 'fs/promises';

const DIR = './test-data-cascade';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('UC-X2: cascade.session', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('cascade.session deletes marked-collection rows for the scope id', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      content:           { type: String, required: false },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });

    await db.add.memoryArtifact({ type: 'fact', content: 'A', source_session_id: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', content: 'B', source_session_id: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', content: 'C', source_session_id: 'S2' });

    await db.cascade.session('S1');

    const remaining = await db.get.memoryArtifactS();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source_session_id).toBe('S2');
  });

  test('collections without cascadeOn are immune (knowledge tier invariant)', async () => {
    db = await freshDB();
    // Memory tier: cascade-eligible
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });
    // Knowledge tier: NO cascadeOn — must be invisible to cascade.session
    db.schema('kgEntity', {
      name: { type: String, required: true }
    });

    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S1' });
    await db.add.kgEntity({ name: 'Alice' });

    await db.cascade.session('S1');

    expect(await db.get.memoryArtifactS()).toHaveLength(0);
    // Knowledge entity must survive — non-negotiable per §10 / V8 §3.6.0
    expect(await db.get.kgEntityS()).toHaveLength(1);
  });

  test('cascade across multiple cascadeOn collections in one call', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });
    db.schema('lexicalEntity', {
      term:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });

    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S2' });
    await db.add.lexicalEntity({ term: 'foo', source_session_id: 'S1' });
    await db.add.lexicalEntity({ term: 'bar', source_session_id: 'S2' });

    await db.cascade.session('S1');

    expect(await db.get.memoryArtifactS()).toHaveLength(1);
    expect(await db.get.lexicalEntityS()).toHaveLength(1);
  });

  test('cascade is idempotent — running twice is a no-op the second time', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });
    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S2' });

    const first = await db.cascade.session('S1');
    expect(first.deleted).toBe(1);

    const second = await db.cascade.session('S1');
    expect(second.deleted).toBe(0);

    expect(await db.get.memoryArtifactS()).toHaveLength(1);
  });

  test('cascade keeps vector and graph indexes consistent with deletes', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      embedding:         { type: 'vector', dims: 4, required: false },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });

    const v = [1, 0, 0, 0];
    const a = await db.add.memoryArtifact({ type: 'fact', embedding: v, source_session_id: 'S1' });
    const b = await db.add.memoryArtifact({ type: 'fact', embedding: v, source_session_id: 'S2' });

    await db.cascade.session('S1');

    // Vector search must not see the cascaded $ID. We pass a vector
    // identical to a's so a stale index entry would surface as a top hit
    // hydrating to null (filtered out) — the assertion is "exactly one hit".
    const hits = await db.get.memoryArtifactS.near(v, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].$ID).toBe(b.$ID);
  });

  test('another session\'s in-flight transaction is unaffected by cascade', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });

    // Committed: one S1 doc, one S2 doc
    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'S2' });

    // Open a transaction, add an S2 doc inside it (not yet committed).
    db.rec();
    const stagedS2 = await db.add.memoryArtifact({
      type: 'fact', source_session_id: 'S2'
    });

    // Cascade S1 — must not touch the open S2 transaction.
    // Pass txnId: null to the cascade so it operates on committed state only.
    await db.cascade.session('S1', { txnId: null });

    // Still inside the txn — staged S2 must still be visible.
    const inside = await db.get.memoryArtifact(stagedS2.$ID);
    expect(inside).toBeTruthy();

    await db.fin();

    // After fin, total docs: 1 S2 (committed) + 1 S2 (staged-then-committed) = 2
    const all = await db.get.memoryArtifactS();
    expect(all).toHaveLength(2);
    for (const d of all) expect(d.source_session_id).toBe('S2');
  });

  test('cascade.byField — explicit collection list as escape hatch', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:    { type: String, required: true },
      tag_id:  { type: String, required: false }  // no cascadeOn — explicit only
    });
    await db.add.memoryArtifact({ type: 'fact', tag_id: 'T1' });
    await db.add.memoryArtifact({ type: 'fact', tag_id: 'T2' });

    const result = await db.cascade.byField({
      collections: ['memoryArtifact'],
      filter: { tag_id: 'T1' }
    });

    expect(result.deleted).toBe(1);
    expect(await db.get.memoryArtifactS()).toHaveLength(1);
  });

  test('cascade with no matching scope returns deleted: 0 silently', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });
    const result = await db.cascade.session('UNKNOWN');
    expect(result.deleted).toBe(0);
  });

  test('cascade.session(X) cancels the in-flight txn owned by session X', async () => {
    // Per spec §2.8 / non-negotiable §0.3 #5: a session-scoped cascade
    // that fires while THAT session has an open transaction must roll
    // back the staged writes before sweeping committed state. This test
    // exercises the contract end-to-end: open a txn tagged with sessionId,
    // stage some adds, fire cascade.session(sessionId), assert the txn is
    // gone (db._activeTxnId nulled) and the staged writes are not present.
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      content:           { type: String, required: false },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });
    // Some pre-existing committed-state for the session (so cascade has
    // something to delete after the txn rollback).
    await db.add.memoryArtifact({ type: 'fact', content: 'committed', source_session_id: 'S1' });

    db.rec({ sessionId: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', content: 'staged-1', source_session_id: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', content: 'staged-2', source_session_id: 'S1' });

    await db.cascade.session('S1');

    expect(db._activeTxnId).toBe(null);
    expect(db._activeTxnSessionId).toBe(null);
    const remaining = await db.get.memoryArtifactS();
    // Cancellation cascade invariant: no doc with source_session_id === S1
    // remains visible across collections (§8 #10).
    for (const row of remaining) {
      expect(row.source_session_id).not.toBe('S1');
    }
  });

  test("cascade.session(X) does NOT touch session Y's open transaction", async () => {
    // Spec §2.8: "NOT delete documents staged inside another (non-cancelled)
    // session's transaction." Concurrent-session model in v1: only one txn
    // active at a time, so the test asserts the simpler property: when the
    // active txn belongs to Y, cascade.session(X) does NOT call nop().
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:              { type: String, required: true },
      source_session_id: { type: String, required: false, cascadeOn: 'session' }
    });
    db.rec({ sessionId: 'Y' });
    await db.add.memoryArtifact({ type: 'fact', source_session_id: 'X' });

    const yTxnId = db._activeTxnId;
    expect(yTxnId).toBeTruthy();

    await db.cascade.session('X');

    expect(db._activeTxnId).toBe(yTxnId);
    expect(db._activeTxnSessionId).toBe('Y');
    await db.fin();
  });

  test('cascade.{unknownScope} throws CASCADE_SCOPE_UNKNOWN per spec §2.11', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', { type: { type: String, required: true } });
    await db.add.memoryArtifact({ type: 'fact' });
    let thrown;
    try { await db.cascade.session('S1'); }
    catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('CASCADE_SCOPE_UNKNOWN');
    expect(thrown.message).toContain('cascadeOn');
  });
});
