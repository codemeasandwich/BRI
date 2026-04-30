/**
 * @file Cross-cutting smoke tests required by the Risk follow-ups plan.
 *
 * These exercise the interaction of all three risks together (clean exit,
 * persistence, bounded hydration with $indexes) in a single flow. They
 * deliberately overlap with the per-risk test suites — that's the point.
 * If any of these fail, the failure is immediate and obvious; if a
 * lower-level test silently regresses, the cross-cutting check still
 * catches it.
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import fs from 'fs/promises';

const DIR = './test-data-cross-cutting';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('Cross-cutting (Risks 1+2+3)', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('insert 5 docs, snapshot, restart, query — all 5 found', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      embedding: { type: 'vector', dims: 4, required: false },
    });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const v = [Math.cos(i), Math.sin(i), 0, 0];
      const doc = await db.add.memoryArtifact({ type: 'fact', embedding: v });
      ids.push(doc.$ID);
    }
    await db._store.createSnapshot();
    await db.disconnect();

    db = await openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      embedding: { type: 'vector', dims: 4, required: false },
    });
    // Each seed vector must still be retrievable as a top-1 hit for itself.
    for (let i = 0; i < 5; i++) {
      const v = [Math.cos(i), Math.sin(i), 0, 0];
      const [hit] = await db.get.memoryArtifactS.near(v, 1);
      expect(hit).toBeDefined();
      expect(ids).toContain(hit.$ID);
      expect(hit.$cosine).toBeGreaterThan(0.99);
    }
  });

  test('1000 docs across 5 types, $indexes prefilters .where + .near', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true },
      embedding: { type: 'vector', dims: 4, required: false },
      $indexes: [['type']]
    });
    const types = ['fact', 'pref', 'task', 'note', 'goal'];
    const v = [1, 0, 0, 0];
    for (let i = 0; i < 1000; i++) {
      await db.add.memoryArtifact({ type: types[i % 5], embedding: v });
    }

    const realGet = db._store.get.bind(db._store);
    const reads = [];
    db._store.get = async function spied(key, opts) {
      reads.push(key);
      return realGet(key, opts);
    };

    const facts = await db.get.memoryArtifactS
      .where({ type: 'fact' })
      .near(v, 5);

    db._store.get = realGet;

    expect(facts).toHaveLength(5);
    for (const f of facts) expect(f.type).toBe('fact');
    // Index-covered filter -> hydration is O(k). Confirm it's well under
    // 200, which would be the candidate-set hydration tier, and far under
    // the full 1000-collection scan.
    const docReads = reads.filter(k => k.startsWith('MECT_'));
    expect(docReads.length).toBeLessThan(200);
  }, 120000);
});
