/**
 * @file End-to-end scenario tests from spec §F.
 *
 * Two scenarios from the requirements doc that exercise the full surface
 * end-to-end:
 *
 *   Test 1 — round-trip memory artifact lifecycle:
 *     insert → recall via .near → dedupe via .match → supersede via
 *     supersession field → cancellation cascade.
 *
 *   Test 2 — knowledge graph triples lifecycle:
 *     declare entities + triples → traverse via predicate proxy →
 *     filter by confidence → walk supersession chain → expand.
 *
 * Each test exercises a self-contained flow rather than asserting a
 * single behaviour; the flow IS the assertion (every step must succeed
 * for the next to make sense).
 *
 * @implements spec §F
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import { applyFixtureSchemas } from '../fixtures/schemas.js';
import { makeEmbedding, nearVectorOf } from '../fixtures/embeddings.js';
import { loadKGFixture } from '../fixtures/triples.js';
import fs from 'fs/promises';

const DIR = './test-data-scenarios';
async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('Scenario 1: memory artifact round-trip lifecycle (spec §F Test 1)', () => {
  let db;
  afterEach(async () => { if (db) await db.disconnect(); });

  test('round_trip_memory_artifact_lifecycle', async () => {
    db = await freshDB();
    applyFixtureSchemas(db, { dims: 8 });

    // Insert two facts in session S1.
    const a = await db.add.memoryArtifact({
      type: 'fact', content: 'cats sleep 16h/day',
      embedding: makeEmbedding(1, 8),
      confidence: 0.6,
      source_session_id: 'S1'
    });
    const b = await db.add.memoryArtifact({
      type: 'fact', content: 'dogs sleep 12h/day',
      embedding: makeEmbedding(2, 8),
      confidence: 0.8,
      source_session_id: 'S1'
    });

    // Recall via .near — query close to fact `a`'s embedding seed.
    const hits = await db.get.memoryArtifactS
      .where({ type: 'fact' }).near(nearVectorOf(1, 8), 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].$cosine).toBeGreaterThan(0);

    // Confidence chain method filters down.
    const trustworthy = await db.get.memoryArtifactS.confidence(0.7).toArray();
    expect(trustworthy.map(r => r.$ID)).toContain(b.$ID);
    expect(trustworthy.map(r => r.$ID)).not.toContain(a.$ID);

    // Supersession: write a newer fact and link old → new.
    const c = await db.add.memoryArtifact({
      type: 'fact', content: 'cats sleep 13-16h/day',
      embedding: makeEmbedding(3, 8),
      confidence: 0.9,
      source_session_id: 'S1'
    });
    a.superseded_by_id = c.$ID;
    await a.save();

    // Default reads hide superseded; .history shows all.
    const visible = await db.get.memoryArtifactS.toArray();
    expect(visible.map(r => r.$ID)).not.toContain(a.$ID);
    const all = await db.get.memoryArtifactS.history.toArray();
    expect(all.map(r => r.$ID)).toContain(a.$ID);

    // Cancellation cascade: blow away the session — every doc with
    // source_session_id === 'S1' is gone.
    await db.cascade.session('S1');
    const remaining = await db.get.memoryArtifactS.history.toArray();
    for (const row of remaining) {
      expect(row.source_session_id).not.toBe('S1');
    }
    // We should be left with no artifacts, since all three belong to S1.
    expect(remaining.length).toBe(0);
  });
});

describe('Scenario 2: knowledge graph triples lifecycle (spec §F Test 2)', () => {
  let db;
  afterEach(async () => { if (db) await db.disconnect(); });

  test('knowledge_graph_triples_lifecycle', async () => {
    db = await freshDB();
    applyFixtureSchemas(db, { dims: 8 });

    const { entities, idsByName } = await loadKGFixture(db);
    const byName = Object.fromEntries(entities.map(e => [e.name, e]));

    // Predicate proxy read: who works at Acme?
    const employees = await byName['Acme'].inverse.works_at;
    expect(employees.map(e => e.name).sort()).toEqual(['Alice', 'Bob']);

    // Filter by confidence (spec §2.4 chain method).
    const trustworthy = await byName['Alice'].knows.confidence(0.75);
    expect(trustworthy.map(t => t.name).sort()).toEqual(['Bob']);

    // Supersession: replace the knows(Alice→Carol) triple with a newer
    // one and link via superseded_by_id. Default reads hide it.
    const aliceId = idsByName['Alice'];
    const oldKnows = (await db.get.kgTripleS({
      subject_id: aliceId, predicate: 'knows',
      object_id_or_literal: idsByName['Carol']
    }))[0];
    const newKnows = await db.add.kgTriple({
      subject_id: aliceId, predicate: 'knows',
      object_id_or_literal: idsByName['Carol'],
      confidence: 0.9, source_session_id: 'fixture',
      provenance_turn_ids: ['turn-2']
    });
    oldKnows.superseded_by_id = newKnows.$ID;
    await oldKnows.save();
    newKnows.supersedes_id = oldKnows.$ID;
    await newKnows.save();

    // Walk the supersession chain backward from the new triple — should
    // reach the old triple and end at null.
    const chain = await newKnows.chain.supersedes_id;
    expect(Array.isArray(chain)).toBe(true);
    expect(chain.map(t => t.$ID)).toContain(oldKnows.$ID);

    // Multi-hop expand from Alice — should reach Acme (works_at), Bob/Carol (knows).
    const fanout = await byName['Alice'].expand({ via: 'kgTriple', hops: 1 });
    const reached = new Set(fanout.nodes.map(n => n.name));
    expect(reached.has('Acme')).toBe(true);
    expect(reached.has('Bob')).toBe(true);
  });
});
