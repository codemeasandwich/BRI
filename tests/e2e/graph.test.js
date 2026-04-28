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

describe('UC-G1 read-side: inverse, related, edge access via .$', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('inverse predicate read returns subjects pointing TO this entity', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const carol = await db.add.kgEntity({ name: 'Carol' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });

    await alice.works_at(acme);
    await bob.works_at(acme);
    await carol.works_at(acme);

    const employees = await acme.inverse.works_at;
    const names = employees.map(e => e.name).sort();
    expect(names).toEqual(['Alice', 'Bob', 'Carol']);
  });

  test('inverse filters by predicate — knows-relations don\'t leak into works_at inverse', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });

    await alice.works_at(acme);
    await bob.knows(acme);  // bob 'knows' acme — must NOT appear as employee

    const employees = await acme.inverse.works_at;
    expect(employees.map(e => e.name)).toEqual(['Alice']);
  });

  test('.related returns flat list of all outgoing targets across all predicates', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });

    await alice.works_at(acme);
    await alice.knows(bob);

    const all = await alice.related;
    const names = all.map(e => e.name).sort();
    expect(names).toEqual(['Acme', 'Bob']);
  });

  test('predicate.$ returns the edge documents themselves', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    await alice.works_at(acme, { confidence: 0.9 });

    const edges = await alice.works_at.$;
    expect(edges).toHaveLength(1);
    expect(edges[0].predicate).toBe('works_at');
    expect(edges[0].subject_id).toBe(alice.$ID);
    expect(edges[0].object_id_or_literal).toBe(acme.$ID);
    expect(edges[0].confidence).toBe(0.9);
  });

  test('inverse predicate.$ returns edge documents (subject side)', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    await alice.works_at(acme, { confidence: 0.9 });
    await bob.works_at(acme, { confidence: 0.6 });

    const edges = await acme.inverse.works_at.$;
    expect(edges).toHaveLength(2);
    const subjectIds = edges.map(e => e.subject_id).sort();
    expect(subjectIds).toEqual([alice.$ID, bob.$ID].sort());
  });

  test('.related.$ returns all outgoing edges across predicates', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });

    await alice.works_at(acme, { confidence: 0.9 });
    await alice.knows(bob, { confidence: 0.8 });

    const edges = await alice.related.$;
    expect(edges).toHaveLength(2);
    const predicates = edges.map(e => e.predicate).sort();
    expect(predicates).toEqual(['knows', 'works_at']);
  });

  test('inverse on entity with no incoming edges yields empty array', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const lonely = await db.add.kgEntity({ name: 'Lonely' });
    const incoming = await lonely.inverse.works_at;
    expect(incoming).toEqual([]);
  });

  test('related on entity with no outgoing edges yields empty array', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const lonely = await db.add.kgEntity({ name: 'Lonely' });
    const all = await lonely.related;
    expect(all).toEqual([]);
  });
});
