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
import { openLocalDatabase } from '../helpers/open-database.js';
import { GraphIndex } from '../../engine/index.js';
import { EDGE_ENDPOINT_INVALID } from '../../engine/errors.js';
import JSS from '../../utils/jss/index.js';
import fs from 'fs/promises';

const DIR = './test-data-graph';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
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

  test('predicate write accepts a string Bri-id endpoint (same as entity.$ID)', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob = await db.add.kgEntity({ name: 'Bob' });
    await alice.knows(bob.$ID);
    const friends = await alice.knows;
    expect(friends.map((e) => e.$ID)).toContain(bob.$ID);
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

  test('schema with ref field name matching reserved proxy token throws at declare', async () => {
    db = await freshDB();
    db.schema('kgEntity', { name: { type: String, required: true } });
    expect(() => {
      db.schema('reservedRefKgTriple', {
        history:                { type: 'ref', to: 'kgEntity', required: true },
        ally:                   { type: 'ref', to: 'kgEntity', required: true },
        predicate:              { type: String, required: true },
        object_id_or_literal:   { type: 'ref', to: 'kgEntity', required: true },
        $edge: {
          from: 'kgEntity',
          to: 'kgEntity',
          predicate: 'predicate',
          predicates: ['knows']
        }
      });
    }).toThrow(/ref field .*history/i);
  });

  test('$edge.to union form registers inverse routing for non-literal targets only', async () => {
    db = await freshDB();
    db.schema('kgEntity', { name: { type: String, required: true } });
    expect(() => {
      db.schema('polyKgTriple', {
        subject_id:            { type: 'ref', to: 'kgEntity', required: true },
        object_id_or_literal:  { type: 'ref|string', to: 'kgEntity', required: true },
        predicate:             { type: String, required: true },
        $edge: {
          from: 'kgEntity',
          to: 'kgEntity | string',
          predicate: 'predicate',
          predicates: ['mentions']
        }
      });
    }).not.toThrow();
  });

  test('$edge with fewer than two ref fields fails at declare (EDGE_REF_FIELDS_MISSING)', async () => {
    db = await freshDB();
    db.schema('soloNode', { label: { type: String, required: true } });
    expect(() => {
      db.schema('soloEdge', {
        peer: { type: 'ref', to: 'soloNode', required: true },
        note: { type: String, required: false },
        $edge: {
          from: 'soloNode',
          to: 'soloNode',
          predicate: 'predicate',
          predicates: ['only']
        }
      });
    }).toThrow(/fewer than two ref fields/i);
  });

  test('duplicate predicate name on same subject collection across edge schemas fails', async () => {
    db = await freshDB();
    db.schema('kgEntity', { name: { type: String, required: true } });
    db.schema('kgTriple', {
      subject_id:           { type: 'ref', to: 'kgEntity', required: true },
      predicate:            { type: String, required: true },
      object_id_or_literal:   { type: 'ref', to: 'kgEntity', required: true },
      $edge: {
        from: 'kgEntity',
        to: 'kgEntity',
        predicate: 'predicate',
        predicates: ['works_at', 'knows']
      }
    });
    expect(() => {
      db.schema('dupTriple', {
        subject_id:           { type: 'ref', to: 'kgEntity', required: true },
        predicate:            { type: String, required: true },
        object_id_or_literal:   { type: 'ref', to: 'kgEntity', required: true },
        $edge: {
          from: 'kgEntity',
          to: 'kgEntity',
          predicate: 'predicate',
          predicates: ['works_at']
        }
      });
    }).toThrow(/registered on both 'kgTriple' and 'dupTriple'/i);
  });

  test('inverse predicate collision on shared object collection fails at declare', async () => {
    db = await freshDB();
    db.schema('invPerson', { name: { type: String, required: true } });
    db.schema('invOrg', { name: { type: String, required: true } });
    db.schema('invThing', { name: { type: String, required: true } });
    db.schema('edgeFromPerson', {
      subj: { type: 'ref', to: 'invPerson', required: true },
      objx: { type: 'ref', to: 'invThing', required: true },
      predicate: { type: String, required: true },
      $edge: {
        from: 'invPerson',
        to: 'invThing',
        predicate: 'predicate',
        predicates: ['tags']
      }
    });
    expect(() => {
      db.schema('edgeFromOrg', {
        subj: { type: 'ref', to: 'invOrg', required: true },
        objx: { type: 'ref', to: 'invThing', required: true },
        predicate: { type: String, required: true },
        $edge: {
          from: 'invOrg',
          to: 'invThing',
          predicate: 'predicate',
          predicates: ['tags']
        }
      });
    }).toThrow(/inverse-registered|PREDICATE_AMBIGUOUS/i);
  });

  test('$confidence pointing at a non-existent field throws INDEX_FIELD_NOT_DECLARED', async () => {
    db = await freshDB();
    expect(() => {
      db.schema('lifecycleTypo', {
        conf: { type: Number, required: false },
        $confidence: 'confTypo'
      });
    }).toThrow(/confTypo/i);
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

  test('inverse proxy rejects Symbol predicate keys (undefined)', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const acme = await db.add.kgEntity({ name: 'AcmeSym' });
    expect(acme.inverse[Symbol.iterator]).toBeUndefined();
    expect(acme.inverse[Symbol('predicate')]).toBeUndefined();
  });

  test('inverse predicate with no inverse mapping yields undefined accessor', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const acme = await db.add.kgEntity({ name: 'AcmeNx' });
    expect(acme.inverse.__not_registered_predicate_xx__).toBeUndefined();
  });

  /** vectorIndexMiddleware POST graph.sync — `set` on edge replaces removeEdge+insertEdge (lines 123-128). */
  test('db.set.kgTriple refreshes cached graph slots when triple document is replaced', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'AliceSet' });
    const bob = await db.add.kgEntity({ name: 'BobSet' });
    const triple = await alice.knows(bob, { confidence: 0.1 });
    const gi = db._registry.graphIndex();
    expect(gi.outgoing(alice.$ID, 'kgTriple', 'knows')).toContain(triple.$ID);
    const body = triple.toObject ? triple.toObject() : { ...triple };
    await db.set.kgTriple({ ...body, confidence: 0.88 });
    const reread = await db.get.kgTriple(triple.$ID);
    expect(reread.confidence).toBeCloseTo(0.88, 5);
    expect(gi.outgoing(alice.$ID, 'kgTriple', 'knows')).toContain(triple.$ID);
    expect(gi.incoming(bob.$ID, 'kgTriple', 'knows')).toContain(triple.$ID);
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

  test('expand skips edge when object endpoint field missing after corrupt store body', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'CorA' });
    const bob = await db.add.kgEntity({ name: 'CorB' });
    const edgeDoc = await alice.knows(bob);

    const raw = await db._store.get(edgeDoc.$ID);
    const parsed = JSS.parse(raw);
    delete parsed.object_id_or_literal;
    await db._store.set(edgeDoc.$ID, JSS.stringify(parsed), {});

    const result = await alice.expand({ via: 'kgTriple', hops: 1 });
    expect(result.complete).toBe(true);
    expect(Array.isArray(result.paths)).toBe(true);
    expect(await alice.knows).toHaveLength(0);
  });

  test('expand({via}) omits hops and defaults to depth 1', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'DhAlice' });
    const bob = await db.add.kgEntity({ name: 'DhBob' });
    await alice.knows(bob);

    const result = await alice.expand({ via: 'kgTriple' });
    expect(result.nodes.some((n) => n.name === 'DhBob')).toBe(true);
    expect(result.complete).toBe(true);
  });

  test('expand tolerates phantom edge ids and duplicate worklist ids (self-loop + both)', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const selfN = await db.add.kgEntity({ name: 'Slf' });
    await selfN.knows(selfN);
    db._registry.graphIndex().insertEdge('kgTriple', {
      $ID: 'KGLE_phantomEx',
      subject_id: selfN.$ID,
      object_id_or_literal: selfN.$ID,
      predicate: 'knows'
    });

    const r = await selfN.expand({
      via: 'kgTriple',
      hops: 1,
      direction: 'both'
    });
    expect(r.paths.length).toBeGreaterThan(0);
    expect(r.complete).toBe(true);
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

  test('expand({edgeFilter}) skips individual edges while continuing the BFS', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'EFAlice' });
    const acme = await db.add.kgEntity({ name: 'EFAcme' });
    const bob = await db.add.kgEntity({ name: 'EFBob' });
    await alice.works_at(acme);
    await alice.knows(bob);

    const result = await alice.expand({
      via: 'kgTriple',
      hops: 1,
      edgeFilter: (edge) => edge.predicate !== 'knows'
    });
    const names = result.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['EFAcme']);
  });

  test('expand({budget:{results}}) sets stop so later frontier nodes are not walked', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const a = await db.add.kgEntity({ name: 'Bga' });
    const b1 = await db.add.kgEntity({ name: 'Bgb1' });
    const b2 = await db.add.kgEntity({ name: 'Bgb2' });
    const c1 = await db.add.kgEntity({ name: 'Bgc1' });
    const c2 = await db.add.kgEntity({ name: 'Bgc2' });
    await a.knows(b1);
    await a.knows(b2);
    await b1.knows(c1);
    await b2.knows(c2);

    const result = await a.expand({
      via: 'kgTriple',
      hops: 2,
      budget: { results: 3 }
    });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('results');
  });

  test('predicate write rejects null target with EDGE_ENDPOINT_INVALID', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'PEAlice' });

    await expect(alice.knows(null)).rejects.toMatchObject({ code: EDGE_ENDPOINT_INVALID });

    await expect(alice.knows({})).rejects.toMatchObject({ code: EDGE_ENDPOINT_INVALID });
  });

  test('expand() with no opts uses default-arg and fails without via', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const a = await db.add.kgEntity({ name: 'ExDef' });

    await expect(a.expand()).rejects.toThrow(/registered edge collection/i);
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

  test('UC-G5: dangling adjacency entry does not crash degree', async () => {
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

  test('degree throws when collection or via is missing', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    await expect(db.algo.degree({ collection: 'kgEntity' })).rejects.toThrow(
      /requires \{ collection, via \}/
    );
    await expect(db.algo.degree({ via: 'kgTriple' })).rejects.toThrow(
      /requires \{ collection, via \}/
    );
  });

  test('degree throws when via is not a registered edge collection', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    await expect(
      db.algo.degree({ collection: 'kgEntity', via: 'kgEntity' })
    ).rejects.toThrow(/not a registered edge collection/);
  });

  test('degree weighted skips phantom edge ids and non-numeric weight fields', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const a = await db.add.kgEntity({ name: 'A' });
    const b = await db.add.kgEntity({ name: 'B' });
    await a.knows(b);
    // Stale adjacency with no backing document; fetchEdge resolves null (line 109 path).
    db._registry.graphIndex().insertEdge('kgTriple', {
      $ID: 'KGTL_phantom_degree',
      subject_id: a.$ID,
      object_id_or_literal: b.$ID,
      predicate: 'knows'
    });
    // `confidence` is absent on real edges → typeof v === 'number' is false (line 111).
    const weighted = await db.algo.degree({
      collection: 'kgEntity',
      via: 'kgTriple',
      weighted: 'confidence'
    });
    expect(weighted.length).toBeGreaterThan(0);
  });

  test('degree drops nodes whose entity hydrate rejects via middleware fault', async () => {
    db = await freshDB();
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const bob = await db.add.kgEntity({ name: 'Bob' });
    await alice.knows(bob);
    /**
     * Singular db.get.kgEntity(id) runs through middleware; group kgEntityS uses
     * ctx.type 'kgEntityS' so enumeration is not affected. The rejection is
     * caught by degree's per-id hydrate (.catch(() => null)).
     */
    const faultInject = async (/** @type {any} */ ctx, /** @type {Function} */ next) => {
      if (ctx.operation !== 'get' || ctx.type !== 'kgEntity') return next();
      const id =
        typeof ctx.args[0] === 'string' ? ctx.args[0] : ctx.args[0]?.$ID;
      if (id && String(id) === String(alice.$ID)) {
        throw new Error('simulated hydrate fault');
      }
      return next();
    };
    db.use(faultInject);
    try {
      const result = await db.algo.degree({
        collection: 'kgEntity',
        via: 'kgTriple'
      });
      expect(result.some(r => String(r.entity.$ID) === String(bob.$ID))).toBe(true);
      expect(result.some(r => String(r.entity.$ID) === String(alice.$ID))).toBe(false);
    } finally {
      db.middleware.remove(faultInject);
    }
  });
});

describe('UC-G4: reference chain walks', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Self-referential ref schema for chain walks. supersedes_id points
   * back to the previous version of the same row; superseded_by_id
   * points forward.
   */
  function declareSupersededSchema(_db) {
    _db.schema('memoryArtifact', {
      content:           { type: String, required: true },
      supersedes_id:     { type: 'ref', to: 'memoryArtifact', required: false },
      superseded_by_id:  { type: 'ref', to: 'memoryArtifact', required: false }
    });
  }

  test('chain walk follows a self-ref forward to null', async () => {
    db = await freshDB();
    declareSupersededSchema(db);
    const v1 = await db.add.memoryArtifact({ content: 'v1' });
    const v2 = await db.add.memoryArtifact({ content: 'v2', supersedes_id: v1.$ID });
    const v3 = await db.add.memoryArtifact({ content: 'v3', supersedes_id: v2.$ID });

    const history = await v3.chain.supersedes_id;
    expect(Array.isArray(history)).toBe(true);
    const contents = history.map(d => d.content);
    expect(contents).toEqual(['v3', 'v2', 'v1']);
  });

  test('callable chain walk with empty parens uses default maxDepth path', async () => {
    db = await freshDB();
    declareSupersededSchema(db);
    const v1 = await db.add.memoryArtifact({ content: 'v1' });
    const v2 = await db.add.memoryArtifact({ content: 'v2', supersedes_id: v1.$ID });
    const v3 = await db.add.memoryArtifact({ content: 'v3', supersedes_id: v2.$ID });
    const history = await v3.chain.supersedes_id();
    expect(Array.isArray(history)).toBe(true);
    expect(history.map((d) => d.content)).toEqual(['v3', 'v2', 'v1']);
  });

  test('chain walk in the opposite direction', async () => {
    db = await freshDB();
    declareSupersededSchema(db);
    const v1 = await db.add.memoryArtifact({ content: 'v1' });
    const v2 = await db.add.memoryArtifact({ content: 'v2', supersedes_id: v1.$ID });
    // Update v1 to point forward.
    const v1ref = await db.get.memoryArtifact(v1.$ID);
    v1ref.superseded_by_id = v2.$ID;
    await v1ref.save();

    const future = await v1ref.chain.superseded_by_id;
    expect(future.map(d => d.content)).toEqual(['v1', 'v2']);
  });

  test('chain walk on a cycle returns cycleDetected without hanging', async () => {
    db = await freshDB();
    declareSupersededSchema(db);
    const a = await db.add.memoryArtifact({ content: 'A' });
    const b = await db.add.memoryArtifact({ content: 'B', supersedes_id: a.$ID });
    // Close the cycle: a.supersedes_id = b
    const aRef = await db.get.memoryArtifact(a.$ID);
    aRef.supersedes_id = b.$ID;
    await aRef.save();

    const result = await aRef.chain.supersedes_id;
    // On cycle, the function returns an object {chain, cycleDetected}
    // instead of a flat array.
    expect(result.cycleDetected).toBe(true);
    expect(Array.isArray(result.chain)).toBe(true);
    expect(result.chain.length).toBeGreaterThan(0);
  });

  test('chain walk respects maxDepth cap', async () => {
    db = await freshDB();
    declareSupersededSchema(db);
    let prev = null;
    for (let i = 0; i < 5; i++) {
      const doc = await db.add.memoryArtifact({
        content: `v${i}`,
        ...(prev ? { supersedes_id: prev.$ID } : {})
      });
      prev = doc;
    }
    const result = await prev.chain.supersedes_id({ maxDepth: 3 });
    expect(result.truncated).toBe(true);
    expect(Array.isArray(result.chain)).toBe(true);
    expect(result.chain.length).toBeLessThanOrEqual(3);
  });

  test('chain walk on a field pointing to a different collection throws', async () => {
    db = await freshDB();
    db.schema('user', { name: { type: String, required: true } });
    db.schema('post', {
      author_id: { type: 'ref', to: 'user', required: true },
      title:     { type: String, required: true }
    });
    const u = await db.add.user({ name: 'Alice' });
    const p = await db.add.post({ author_id: u.$ID, title: 'hello' });

    // author_id points to user, not post — chain.field must reject this.
    await expect(p.chain.author_id).rejects.toThrow(/cross.*collection|self-ref/i);
  });

  test('chain walk with no value at the start returns just the seed', async () => {
    db = await freshDB();
    declareSupersededSchema(db);
    const orphan = await db.add.memoryArtifact({ content: 'no-pred' });
    const chain = await orphan.chain.supersedes_id;
    expect(chain.map(d => d.content)).toEqual(['no-pred']);
  });
});

describe('UC-G1: predicate chain methods (.history / .confidence / .withProvenance)', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Extended schema with $supersession + $confidence + $provenance flags.
   * The edge document carries supersession backref, confidence score,
   * and a provenance turn-id list.
   */
  function declareKnowledgeSchema(_db) {
    _db.schema('kgEntity', { name: { type: String, required: true } });
    _db.schema('kgTriple', {
      subject_id:           { type: 'ref', to: 'kgEntity', required: true },
      predicate:            { type: String, required: true },
      object_id_or_literal: { type: 'ref', to: 'kgEntity', required: true },
      confidence:           { type: Number, required: false },
      superseded_by_id:     { type: 'ref', to: 'kgTriple', required: false },
      provenance_turn_ids:  { type: Array, required: false, items: String },
      $edge: {
        from: 'kgEntity', to: 'kgEntity',
        predicate: 'predicate',
        predicates: ['works_at', 'knows']
      },
      $supersession: 'superseded_by_id',
      $confidence:   'confidence',
      $provenance:   'provenance_turn_ids'
    });
  }

  test('predicate read default-filters out superseded edges', async () => {
    db = await freshDB();
    declareKnowledgeSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    const initech = await db.add.kgEntity({ name: 'Initech' });

    const oldEdge = await alice.works_at(acme);
    const newEdge = await alice.works_at(initech);
    // Mark old edge as superseded by the new one.
    const oldRef = await db.get.kgTriple(oldEdge.$ID);
    oldRef.superseded_by_id = newEdge.$ID;
    await oldRef.save();

    const current = await alice.works_at;
    const names = current.map(e => e.name);
    expect(names).toEqual(['Initech']);  // Acme filtered out as superseded
  });

  test('.history opts out of supersession filter — sees all edges', async () => {
    db = await freshDB();
    declareKnowledgeSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    const initech = await db.add.kgEntity({ name: 'Initech' });

    const oldEdge = await alice.works_at(acme);
    const newEdge = await alice.works_at(initech);
    const oldRef = await db.get.kgTriple(oldEdge.$ID);
    oldRef.superseded_by_id = newEdge.$ID;
    await oldRef.save();

    const all = await alice.works_at.history;
    const names = all.map(e => e.name).sort();
    expect(names).toEqual(['Acme', 'Initech']);
  });

  test('.confidence(t) filters edges by confidence threshold', async () => {
    db = await freshDB();
    declareKnowledgeSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    const initech = await db.add.kgEntity({ name: 'Initech' });
    const evil  = await db.add.kgEntity({ name: 'Evil' });

    await alice.works_at(acme,    { confidence: 0.95 });
    await alice.works_at(initech, { confidence: 0.6 });
    await alice.works_at(evil,    { confidence: 0.2 });

    const trustworthy = await alice.works_at.confidence(0.5);
    const names = trustworthy.map(e => e.name).sort();
    expect(names).toEqual(['Acme', 'Initech']);
  });

  test('.withProvenance attaches $provenance metadata', async () => {
    db = await freshDB();
    declareKnowledgeSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    await alice.works_at(acme, { provenance_turn_ids: ['T1', 'T2', 'T3'] });

    const [hit] = await alice.works_at.withProvenance;
    expect(hit.name).toBe('Acme');
    expect(hit.$provenance).toEqual(['T1', 'T2', 'T3']);
  });

  test('.withProvenance leaves target without $provenance when edge omits provenance field', async () => {
    db = await freshDB();
    declareKnowledgeSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme = await db.add.kgEntity({ name: 'Acme' });
    await alice.works_at(acme);
    const [hit] = await alice.works_at.withProvenance;
    expect(hit.name).toBe('Acme');
    expect(Object.prototype.hasOwnProperty.call(hit, '$provenance')).toBe(false);
  });

  test('chain methods absent when schema does not declare the corresponding field', async () => {
    db = await freshDB();
    // Minimal schema without $supersession / $confidence / $provenance
    declareSocialSchema(db);
    const alice = await db.add.kgEntity({ name: 'Alice' });
    const acme  = await db.add.kgEntity({ name: 'Acme' });
    await alice.works_at(acme);

    // .history is undefined when no $supersession declared
    expect(alice.works_at.history).toBeUndefined();
    // .confidence callable should also be absent
    expect(alice.works_at.confidence).toBeUndefined();
    // .withProvenance same
    expect(alice.works_at.withProvenance).toBeUndefined();

    // But the basic read still works
    const targets = await alice.works_at;
    expect(targets).toHaveLength(1);
  });
});

describe('GraphIndex persistence contract (serialize/load + edgeSpec paths)', () => {
  test('serialize then load preserves outgoing and incoming adjacency', () => {
    const g = new GraphIndex();
    const spec = {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate',
      fromCollection: 'kgEntity',
      toCollection: 'kgEntity',
      predicates: ['works_at']
    };
    g.declareEdge('kgTriple', spec);
    g.insertEdge('kgTriple', {
      $ID:           'E_test_1',
      subject_id:          'A_x',
      object_id_or_literal: 'O_y',
      predicate:           'works_at'
    });

    const blob = g.serialize();
    const h = new GraphIndex();
    h.load(blob);

    expect(h.outgoing('A_x', 'kgTriple', 'works_at')).toContain('E_test_1');
    expect(h.incoming('O_y', 'kgTriple', 'works_at')).toContain('E_test_1');
  });

  test('insertEdge is a no-op for undeclared edge collection', () => {
    const g = new GraphIndex();
    g.insertEdge('noopCol', {
      $ID: 'e1',
      subject_id: 'a',
      object_id_or_literal: 'b',
      predicate: 'knows'
    });
    expect(g.outgoing('a', 'noopCol', 'knows')).toEqual([]);
  });

  test('omit predicate column in schema — buckets use "*" internally', () => {
    const g = new GraphIndex();
    // No `predicate:` key on spec — insertEdge treats label as '*' (see graph-index §2.6)
    g.declareEdge('relaxed', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      fromCollection: 'kgEntity',
      toCollection: 'kgEntity',
      predicates: ['works_at']
    });
    g.insertEdge('relaxed', {
      $ID:           'E_r',
      subject_id:          'Sx',
      object_id_or_literal: 'Oz'
    });
    expect(g.outgoing('Sx', 'relaxed', '*')).toContain('E_r');
  });

  test('outgoing without predicate returns edges from every predicate bucket', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate',
      predicates: ['works_at', 'knows']
    });
    g.insertEdge('kgTriple', {
      $ID: 'E_m1',
      subject_id: 'AL',
      object_id_or_literal: 'BZ',
      predicate: 'knows'
    });
    g.insertEdge('kgTriple', {
      $ID: 'E_m2',
      subject_id: 'AL',
      object_id_or_literal: 'CW',
      predicate: 'works_at'
    });
    const ids = g.outgoing('AL', 'kgTriple');
    expect(ids.sort()).toEqual(['E_m1', 'E_m2'].sort());
  });

  test('load(null) clears index state after deserialize round-trip', () => {
    const g = new GraphIndex();
    g.declareEdge('solo', {
      from: 'a',
      to: 'b',
      predicates: []
    });
    g.insertEdge('solo', {
      $ID: 'soloE',
      a: '1',
      b: '2'
    });
    const snapshot = g.serialize();
    const h = new GraphIndex();
    h.load(snapshot);
    expect(h.outgoing('1', 'solo', '*')).toContain('soloE');
    h.load(null);
    expect(h.outgoing('1', 'solo', '*')).toEqual([]);
  });

  test('declareEdge is idempotent when the same edge collection repeats', () => {
    const g = new GraphIndex();
    const spec = {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    };
    g.declareEdge('repeat', spec);
    g.declareEdge('repeat', spec);
    expect(g.edgeSpecFor('repeat')).toEqual(spec);
  });

  test('predicate bucket falls back to asterisk when stored predicate column is empty string', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    g.insertEdge('kgTriple', {
      $ID: 'E_empty_pred',
      subject_id: 'S_ep',
      object_id_or_literal: 'O_ep',
      predicate: ''
    });
    expect(g.outgoing('S_ep', 'kgTriple', '*')).toContain('E_empty_pred');
    expect(g.incoming('O_ep', 'kgTriple', '*')).toContain('E_empty_pred');
    g.removeEdge('kgTriple', {
      $ID: 'E_empty_pred',
      subject_id: 'S_ep',
      object_id_or_literal: 'O_ep',
      predicate: ''
    });
    expect(g.outgoing('S_ep', 'kgTriple', '*')).not.toContain('E_empty_pred');
  });

  test('omit predicate column in edge spec buckets insert/remove under asterisk only', () => {
    const g = new GraphIndex();
    g.declareEdge('relBare', {
      from: 'from_id',
      to: 'to_id'
    });
    g.insertEdge('relBare', {
      $ID: 'RB_x',
      from_id: 'Fb',
      to_id: 'Tb'
    });
    expect(g.outgoing('Fb', 'relBare', '*')).toContain('RB_x');
    g.removeEdge('relBare', {
      $ID: 'RB_x',
      from_id: 'Fb',
      to_id: 'Tb'
    });
    expect(g.outgoing('Fb', 'relBare', '*')).not.toContain('RB_x');
  });

  test('insertEdge ignores documents missing required endpoint fields', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    g.insertEdge('kgTriple', {
      $ID: 'E_bad',
      subject_id: '',
      object_id_or_literal: 'Oz',
      predicate: 'works_at'
    });
    expect(g.outgoing('', 'kgTriple', 'works_at')).not.toContain('E_bad');
    expect(g.incoming('Oz', 'kgTriple', 'works_at')).not.toContain('E_bad');
  });

  test('outgoing rejects unknown predicates with an empty slice', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    g.insertEdge('kgTriple', {
      $ID: 'E_z',
      subject_id: 'S0',
      object_id_or_literal: 'O0',
      predicate: 'works_at'
    });
    expect(g.outgoing('S0', 'kgTriple', '__no_such_predicate__')).toEqual([]);
  });

  test('insertEdge recreates per-collection directional maps after truncation', () => {
    const g = new GraphIndex();
    const spec = {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    };
    g.declareEdge('kgTriple', spec);
    g._outgoing.delete('kgTriple');
    g._incoming.delete('kgTriple');
    g.insertEdge('kgTriple', {
      $ID: 'E_reload',
      subject_id: 'Srel',
      object_id_or_literal: 'Orel',
      predicate: 'knows'
    });
    expect(g.outgoing('Srel', 'kgTriple', 'knows')).toContain('E_reload');
    expect(g.incoming('Orel', 'kgTriple', 'knows')).toContain('E_reload');
  });

  test('indexed predicate resolves to asterisk bucket when stored value empty', () => {
    const g = new GraphIndex();
    g.declareEdge('pf', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    g.insertEdge('pf', {
      $ID: 'E_ast',
      subject_id: 'S_ast',
      object_id_or_literal: 'O_ast',
      predicate: ''
    });
    expect(g.outgoing('S_ast', 'pf', '*')).toContain('E_ast');
    expect(g.incoming('O_ast', 'pf', '*')).toContain('E_ast');
  });

  test('removeEdge is a fast no-op without a hydrated document body', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    expect(() => g.removeEdge('kgTriple', null)).not.toThrow();
  });

  test('removeEdge on undeclared collections does not mutate state', () => {
    const g = new GraphIndex();
    expect(() =>
      g.removeEdge('ghostCol', {
        $ID: 'EDGE_x',
        subject_id: 'A',
        object_id_or_literal: 'B',
        predicate: 'p'
      })
    ).not.toThrow();
  });

  test('mis-keyed removal leaves adjacency untouched', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    g.insertEdge('kgTriple', {
      $ID:          'EDGE_ok',
      subject_id:          'Sb',
      object_id_or_literal: 'Ob',
      predicate:           'works_at'
    });
    g.removeEdge('kgTriple', {
      $ID:          'EDGE_ok',
      subject_id:          '__wrong_subject__',
      object_id_or_literal: 'Ob',
      predicate:           'works_at'
    });
    expect(g.outgoing('Sb', 'kgTriple', 'works_at')).toContain('EDGE_ok');
    g.removeEdge('kgTriple', {
      $ID:          'EDGE_ok',
      subject_id:          'Sb',
      object_id_or_literal: 'Ob',
      predicate:           'knows'
    });
    expect(g.outgoing('Sb', 'kgTriple', 'works_at')).toContain('EDGE_ok');
  });

  test('load accepts minimal snapshot objects with empty compartments', () => {
    const g = new GraphIndex();
    expect(() =>
      g.load({
        specs: {},
        outgoing: {},
        incoming: {}
      })
    ).not.toThrow();
  });

  test('removeEdge skips rows with missing endpoints even when $ID remains', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    expect(() =>
      g.removeEdge('kgTriple', {
        $ID: 'EDGE_hf',
        subject_id: '',
        object_id_or_literal: 'Oz',
        predicate: 'works_at'
      })
    ).not.toThrow();
  });

  test('last edge deletion prunes sparse predicate buckets', () => {
    const g = new GraphIndex();
    g.declareEdge('soloEdge', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    const doc = {
      $ID: 'ONLY',
      subject_id: 'Sx',
      object_id_or_literal: 'Oz',
      predicate: 'p1'
    };
    g.insertEdge('soloEdge', doc);
    g.removeEdge('soloEdge', doc);
    expect(g.outgoing('Sx', 'soloEdge', 'p1')).toEqual([]);
  });

  test('_removeAdjacency keeps predicate buckets until final edge drops', () => {
    const g = new GraphIndex();
    g.declareEdge('dupPred', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    const a = {
      $ID:                  'Ea',
      subject_id:          'Sab',
      object_id_or_literal: 'O_a',
      predicate:           'knows'
    };
    const b = {
      $ID:                  'Eb',
      subject_id:          'Sab',
      object_id_or_literal: 'O_b',
      predicate:           'knows'
    };
    g.insertEdge('dupPred', a);
    g.insertEdge('dupPred', b);
    g.removeEdge('dupPred', a);
    expect(g.outgoing('Sab', 'dupPred', 'knows')).toEqual(['Eb']);
    g.removeEdge('dupPred', b);
    expect(g.outgoing('Sab', 'dupPred', 'knows')).toEqual([]);
  });

  test('directional shard missing before remove Edge becomes a tolerant no-op', () => {
    const g = new GraphIndex();
    g.declareEdge('kgTriple', {
      from: 'subject_id',
      to: 'object_id_or_literal',
      predicate: 'predicate'
    });
    g.insertEdge('kgTriple', {
      $ID: 'SHARD_rm',
      subject_id: 'Subj_shard',
      object_id_or_literal: 'Obj_shard',
      predicate: 'works_at'
    });
    g._outgoing.delete('kgTriple');
    expect(() =>
      g.removeEdge('kgTriple', {
        $ID: 'SHARD_rm',
        subject_id: 'Subj_shard',
        object_id_or_literal: 'Obj_shard',
        predicate: 'works_at'
      })
    ).not.toThrow();
  });

  test('load tolerates snapshots that omit directional blobs', () => {
    const g = new GraphIndex();
    expect(() => g.load({ specs: {}, outgoing: undefined, incoming: undefined })).not.toThrow();
  });

  test('load coalesces nullable specs slot like storage recovery artifacts', () => {
    const g = new GraphIndex();
    expect(() => g.load({ specs: null, outgoing: {}, incoming: {} })).not.toThrow();
  });

  test('full graph rebuild: delete lone edge clears adjacency entries', async () => {
    const dir = `./test-data-graph-del-${Math.random().toString(36).slice(2)}`;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    const db = await openLocalDatabase({
      storeConfig: { dataDir: dir, maxMemoryMB: 64 }
    });
    declareSocialSchema(db);
    try {
      const alice = await db.add.kgEntity({ name: 'Alice' });
      const acme  = await db.add.kgEntity({ name: 'Acme' });
      const edge  = await alice.works_at(acme);
      const gi = db._registry.graphIndex();
      expect(gi.outgoing(alice.$ID, 'kgTriple', 'works_at')).toContain(edge.$ID);

      await db.del.kgTriple(edge.$ID);

      expect(gi.outgoing(alice.$ID, 'kgTriple', 'works_at')).not.toContain(edge.$ID);
    } finally {
      await db.disconnect();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
