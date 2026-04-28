/**
 * @file UC-G1 acceptance tests — predicate proxy + edge collections
 *
 * Acceptance criteria (spec §4 UC-G1):
 *   - one_hop_seeds_to_triples: given seed entity, predicate read returns
 *     all outgoing edges for that predicate
 *   - filter_predicates_apply: only the named predicate's targets are
 *     returned, others are filtered out
 *   - top_k_by_score: results respect a top-k cap
 *   - single_round_trip_with_hydration: target entities are resolved as
 *     part of the read, no separate hydration round-trips
 *
 * Plus reserved-name collision detection (§0.4) — schema load throws if a
 * predicate name collides with a method already used by the proxy surface.
 *
 * @implements UC-G1
 */
import { jest } from '@jest/globals';
import { createDB } from '../../client/index.js';
import fs from 'fs/promises';

const DIR = './test-data-graph';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return createDB({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

/**
 * Declare a small social-graph schema:
 *   kgEntity (nodes), kgTriple (edges), with predicates works_at, knows.
 *
 * @param {Object} db
 */
function declareSocialSchema(db) {
  db.schema('kgEntity', {
    name: { type: String, required: true }
  });
  db.schema('kgTriple', {
    subject_id:           { type: 'ref', to: 'kgEntity', required: true },
    predicate:            { type: String, required: true },
    object_id_or_literal: { type: 'ref', to: 'kgEntity', required: true },
    confidence:           { type: Number, required: false },
    $edge: {
      from:       'kgEntity',
      to:         'kgEntity',
      predicate:  'predicate',
      predicates: ['works_at', 'knows']
    }
  });
}

describe('UC-G1: Predicate proxy + edge collections', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('predicate read returns outgoing targets for a single predicate', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme = await db.add.kgEntity({ name: 'Acme' });
    const initech = await db.add.kgEntity({ name: 'Initech' });

    // Write edges via the predicate proxy.
    await alice.works_at(acme, { confidence: 0.9 });
    await alice.works_at(initech, { confidence: 0.6 });

    // Read targets via predicate access.
    const employers = await alice.works_at;
    const employerNames = employers.map(e => e.name).sort();
    expect(employerNames).toEqual(['Acme', 'Initech']);
  });

  test('predicate read filters out edges of other predicates', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob = await db.add.kgEntity({ name: 'Bob' });
    const acme = await db.add.kgEntity({ name: 'Acme' });

    await alice.works_at(acme);
    await alice.knows(bob);

    const employers = await alice.works_at;
    expect(employers.map(e => e.name)).toEqual(['Acme']);

    const friends = await alice.knows;
    expect(friends.map(e => e.name)).toEqual(['Bob']);
  });

  test('targets are fully-hydrated reactive entities (single round-trip semantics)', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme = await db.add.kgEntity({ name: 'Acme' });
    await alice.works_at(acme, { confidence: 0.9 });

    const [employer] = await alice.works_at;
    expect(employer.$ID).toBe(acme.$ID);
    expect(employer.name).toBe('Acme');
    // Reactive — saves work as on any other entity returned from the engine.
    expect(typeof employer.save).toBe('function');
  });

  test('predicate write inserts an edge document with subject/predicate/object', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme = await db.add.kgEntity({ name: 'Acme' });

    const edge = await alice.works_at(acme, { confidence: 0.9 });

    expect(edge.$ID).toBeDefined();
    // Inspect the underlying triple body via the standard get path.
    const fetched = await db.get.kgTriple(edge.$ID);
    expect(fetched.subject_id).toBe(alice.$ID);
    expect(fetched.predicate).toBe('works_at');
    expect(fetched.object_id_or_literal).toBe(acme.$ID);
    expect(fetched.confidence).toBe(0.9);
  });

  test('schema with predicate that collides with reserved name throws at declare', async () => {
    db = await freshDB();
    db.schema('kgEntity', { name: { type: String, required: true } });
    expect(() => {
      db.schema('kgTriple', {
        subject_id:           { type: 'ref', to: 'kgEntity', required: true },
        predicate:            { type: String, required: true },
        object_id_or_literal: { type: 'ref', to: 'kgEntity', required: true },
        $edge: {
          from: 'kgEntity', to: 'kgEntity',
          predicate: 'predicate',
          // 'history' is on the reserved-name list (§0.4)
          predicates: ['works_at', 'history']
        }
      });
    }).toThrow(/history.*reserved/i);
  });

  test('predicate read on collection without registered edges still works for fields', async () => {
    db = await freshDB();
    db.schema('user', { name: { type: String, required: true } });
    const u = await db.add.user({ name: 'Alice' });
    // No predicates registered for 'user'. Property access must still
    // return the field value (regression guard: the predicate-aware proxy
    // must not break basic attribute reads).
    expect(u.name).toBe('Alice');
  });

  test('outgoing edges are bounded by k via .limit on the predicate read', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    for (let i = 0; i < 10; i++) {
      const c = await db.add.kgEntity({ name: `Co-${i}` });
      await alice.works_at(c);
    }
    const top3 = await alice.works_at.limit(3);
    expect(top3).toHaveLength(3);
  });
});
