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

describe('UC-G6: multi-hop expand', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('expand({hops:1}) returns one-hop neighbourhood', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    await alice.works_at(acme);
    await alice.knows(bob);

    const result = await alice.expand({ via: 'kgTriple', hops: 1 });
    const nodeNames = result.nodes.map(n => n.name).sort();
    expect(nodeNames).toEqual(['Acme', 'Bob']);
    expect(result.edges).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  test('expand({hops:2}) returns two-hop reachable set', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const carol = await db.add.kgEntity({ name: 'Carol' });
    await alice.knows(bob);
    await bob.knows(carol);

    const result = await alice.expand({ via: 'kgTriple', hops: 2 });
    const names = result.nodes.map(n => n.name).sort();
    // 'Alice' may or may not be in nodes depending on impl — assert that
    // bob and carol are reachable, which is the spec-relevant claim.
    expect(names).toContain('Bob');
    expect(names).toContain('Carol');
  });

  test('expand cycles do not explode (visited-set termination)', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const a = await db.add.kgEntity({ name: 'A' });
    const b = await db.add.kgEntity({ name: 'B' });
    const c = await db.add.kgEntity({ name: 'C' });
    // Cycle: A -> B -> C -> A
    await a.knows(b);
    await b.knows(c);
    await c.knows(a);

    const result = await a.expand({ via: 'kgTriple', hops: 5 });
    // The reachable set is just {B, C} (A is the seed); cycle should not
    // produce duplicates or hang.
    const names = result.nodes.map(n => n.name).sort();
    expect(names.filter(n => n === 'B')).toHaveLength(1);
    expect(names.filter(n => n === 'C')).toHaveLength(1);
  });

  test('expand({predicates: [...]}) filters edges to allowed predicates', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    await alice.works_at(acme);
    await alice.knows(bob);

    const result = await alice.expand({
      via: 'kgTriple', hops: 1, predicates: ['works_at']
    });
    const names = result.nodes.map(n => n.name);
    expect(names).toEqual(['Acme']);
  });

  test('expand({budget: {results: N}}) caps results and flags incomplete', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    for (let i = 0; i < 10; i++) {
      const c = await db.add.kgEntity({ name: `Co-${i}` });
      await alice.works_at(c);
    }

    const result = await alice.expand({
      via: 'kgTriple', hops: 1, budget: { results: 3 }
    });
    expect(result.nodes.length).toBeLessThanOrEqual(3);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('results');
  });

  test('expand returns paths from seed', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    await alice.knows(bob);

    const result = await alice.expand({ via: 'kgTriple', hops: 1 });
    expect(result.paths).toBeDefined();
    expect(result.paths.length).toBeGreaterThan(0);
    // Each path is alternating [nodeId, edgeId, nodeId, ...] starting at the seed.
    expect(result.paths[0][0]).toBe(alice.$ID);
  });

  test('expand({direction: "in"}) walks incoming edges', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const carol = await db.add.kgEntity({ name: 'Carol' });
    // alice and bob both know carol; carol's incoming gives both back.
    await alice.knows(carol);
    await bob.knows(carol);

    const result = await carol.expand({ via: 'kgTriple', hops: 1, direction: 'in' });
    const names = result.nodes.map(n => n.name).sort();
    expect(names).toEqual(['Alice', 'Bob']);
  });
});

describe('UC-G5: db.algo.degree', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('degree returns nodes sorted by total degree desc', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob   = await db.add.kgEntity({ name: 'Bob' });
    const carol = await db.add.kgEntity({ name: 'Carol' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });

    // Acme is the popular employer (3 incoming).
    await alice.works_at(acme);
    await bob.works_at(acme);
    await carol.works_at(acme);
    // Alice has additional outgoing.
    await alice.knows(bob);

    const result = await db.algo.degree({
      collection: 'kgEntity',
      via: 'kgTriple'
    });

    const top = Object.fromEntries(result.map(r => [r.entity.name, r.degree]));
    // Acme: 3 incoming = 3
    // Alice: 1 outgoing (works_at) + 1 outgoing (knows) = 2
    // Bob: 1 outgoing + 1 incoming = 2
    // Carol: 1 outgoing = 1
    expect(top.Acme).toBe(3);
    expect(result[0].entity.name).toBe('Acme');
  });

  test('degree({weighted: field}) sums an edge attribute instead of count', async () => {
    db = await freshDB();
    db.schema('lexicalEntity', { term: { type: String, required: true } });
    db.schema('lexicalEdge', {
      a:           { type: 'ref', to: 'lexicalEntity', required: true },
      b:           { type: 'ref', to: 'lexicalEntity', required: true },
      cooccur:     { type: Number, required: false },
      $edge: { from: 'lexicalEntity', to: 'lexicalEntity', predicates: ['co_occurs'], predicate: null }
    });
    const alpha = await db.add.lexicalEntity({ term: 'alpha' });
    const beta  = await db.add.lexicalEntity({ term: 'beta' });
    const gamma = await db.add.lexicalEntity({ term: 'gamma' });
    await alpha.co_occurs(beta,  { cooccur: 5 });
    await alpha.co_occurs(gamma, { cooccur: 3 });
    await beta.co_occurs(gamma,  { cooccur: 1 });

    const result = await db.algo.degree({
      collection: 'lexicalEntity',
      via: 'lexicalEdge',
      weighted: 'cooccur'
    });
    const byTerm = Object.fromEntries(result.map(r => [r.entity.term, r.degree]));
    // alpha: 5+3 = 8 (out)
    // beta: 5 (in) + 1 (out) = 6
    // gamma: 3 (in) + 1 (in) = 4
    expect(byTerm.alpha).toBe(8);
    expect(byTerm.beta).toBe(6);
    expect(byTerm.gamma).toBe(4);
  });

  test('degree({top: N}) caps the result', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const a = await db.add.kgEntity({ name: 'A' });
    const b = await db.add.kgEntity({ name: 'B' });
    const c = await db.add.kgEntity({ name: 'C' });
    await a.knows(b);
    await b.knows(c);

    const result = await db.algo.degree({
      collection: 'kgEntity', via: 'kgTriple', top: 1
    });
    expect(result).toHaveLength(1);
  });

  test('dangling adjacency entry does not crash degree', async () => {
    // Edge case: an edge document was deleted but a stale adjacency entry
    // remains (shouldn't happen given middleware, but a regression test
    // gates the resilience contract).
    db = await freshDB();
    declareSocialSchema(db);
    const a = await db.add.kgEntity({ name: 'A' });
    const b = await db.add.kgEntity({ name: 'B' });
    await a.knows(b);

    // Manually corrupt: inject a phantom edge id into the graph index.
    db._registry.graphIndex().insertEdge('kgTriple', {
      $ID: 'KGTL_phantom', subject_id: a.$ID, object_id_or_literal: b.$ID, predicate: 'knows'
    });

    // Should not throw — degree should ignore the phantom and proceed.
    const result = await db.algo.degree({
      collection: 'kgEntity', via: 'kgTriple'
    });
    expect(result.length).toBeGreaterThan(0);
  });
});
