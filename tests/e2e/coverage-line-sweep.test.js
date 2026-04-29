/**
 * @file Scenarios that flip specific statements not hit by feature-oriented
 * suites alone. Every test drives the public createDB / createStore / utils
 * façade; assertions are behavioral (throws, counts, iterator shape).
 *
 * Domain + technical: these paths are valid operator inputs (bad names,
 * malformed chains, recovery edge cases) or contract errors the product must
 * surface deterministically.
 */

import {
  describe, test, expect
} from '@jest/globals';
import { createDB } from '../../client/index.js';
import { createStore } from '../../storage/index.js';
import { isPartialMatch } from '../../utils/diff/index.js';
import JSS from '../../utils/jss/index.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const root = path.join(os.tmpdir(), `bri-line-sweep-${Math.random().toString(36).slice(2)}`);

/**
 * @param {number} d
 * @returns {Float32Array}
 */
function fv(d) {
  return new Float32Array(Array.from({ length: d }, (_, i) => (i + 1) * 0.1));
}

describe('coverage line sweep — client + storage', () => {
  test('InHouseAdapter.vectorEntries iterable (empty registry)', async () => {
    const dir = path.join(root, 'vec-entries');
    await fs.mkdir(dir, { recursive: true });
    const store = await createStore({
      config: { dataDir: dir, maxMemoryMB: 32 }
    });
    const first = store.vectorEntries().next();
    expect(first.done).toBe(true);
    await store.disconnect();
  });

  test('loadVectorState tolerates schema with missing index blob (empty registry entry)', async () => {
    const dir = path.join(root, 'load-vec-missing-blob');
    await fs.mkdir(dir, { recursive: true });
    const store = await createStore({
      config: { dataDir: dir, maxMemoryMB: 32 }
    });
    store.loadVectorState(
      {},
      { orphanCol: { field: 'e', dims: 3, metric: 'cosine' } }
    );
    const entry = store.getVectorEntry('orphanCol');
    expect(entry.index).toBeDefined();
    await store.disconnect();
  });

  test('db.get rejects invalid collection token (proxy name pattern)', async () => {
    const dir = path.join(root, 'bad-col');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 40 } });
    expect(() => {
      void db.get['no-hyphens-allowed'];
    }).toThrow(/not a good collection name/i);
    await db.disconnect();
  });

  test('.near throws when collection has no vector field (vector exec guard)', async () => {
    const dir = path.join(root, 'no-vec-near');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 40 } });
    db.schema('flatDoc', { text: { type: String, required: true } });
    await db.add.flatDoc({ text: 'hello' });
    await expect(
      db.get.flatDocS.where({ text: 'hello' }).near(fv(4), 3).toArray()
    ).rejects.toThrow(/no vector field/i);
    await db.disconnect();
  });

  test('schema declare throws when two vector fields are declared', async () => {
    const dir = path.join(root, 'two-vec');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 40 } });
    expect(() =>
      db.schema('badTwoVec', {
        a: { type: 'vector', dims: 3 },
        b: { type: 'vector', dims: 3 }
      })
    ).toThrow(/more than one vector field/i);
    await db.disconnect();
  });

  test('substring match on numeric field uses non-string fieldContains path', async () => {
    const dir = path.join(root, 'match-num-field');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 40 } });
    db.schema('numRow', { code: { type: Number, required: true } });
    await db.add.numRow({ code: 4242 });
    const none = await db.get.numRowS.match({ code: '24' });
    expect(none).toHaveLength(0);
    await db.disconnect();
  });

  test('.match k and .limit both numbers use smaller cap', async () => {
    const dir = path.join(root, 'match-limit-min');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('noteRow', { text: { type: String, required: true } });
    for (let i = 0; i < 8; i++) {
      await db.add.noteRow({ text: `shared token ${i}` });
    }
    const rows = await db.get.noteRowS
      .match({ text: 'shared' }, 8)
      .limit(2)
      .toArray();
    expect(rows).toHaveLength(2);
    await db.disconnect();
  });

  test('QueryBuilder rejects invalid vector + k for .near / .match / .combine / combine order', async () => {
    const dir = path.join(root, 'qb-throws');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('vecRow', {
      alias: { type: String, required: true },
      embedding: { type: 'vector', dims: 4, required: false }
    });
    const q = fv(4);
    expect(() => {
      db.get.vecRowS.where({}).near({ not: 'vec' }, 3);
    }).toThrow();

    expect(() => {
      db.get.vecRowS.near(q, 0);
    }).toThrow();

    expect(() => {
      db.get.vecRowS.match(null);
    }).toThrow();

    expect(() => {
      db.get.vecRowS.combine({ alias: 1 });
    }).toThrow();

    await expect(
      db.get.vecRowS.combine({ alias: 0.5, vector: 0.5 }).toArray()
    ).rejects.toMatchObject({ code: 'COMBINE_PRECONDITIONS_UNMET' });

    await expect(
      db.get.vecRowS.match({ alias: 'x' }).near(q, 5).toArray()
    ).rejects.toMatchObject({ code: 'COMBINE_REQUIRED_FOR_HYBRID' });

    await expect(
      db.get.vecRowS.where({}).limit(3).toArray()
    ).resolves.toBeDefined();

    await db.disconnect();
  });

  test('cascade.byField throws on invalid arguments', async () => {
    const dir = path.join(root, 'cascade-bad-args');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 40 } });
    db.schema('rowX', { t: { type: String, required: true } });
    await expect(db.cascade.byField({ collections: [], filter: null })).rejects.toThrow();
    await db.disconnect();
  });

  test('cascade.byField honors opts.atomic transactional wrapper', async () => {
    const dir = path.join(root, 'cascade-atomic');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 56 } });
    db.schema('rowY', {
      mark: { type: String, required: false }
    });
    await db.add.rowY({ mark: 'delete-me' });
    await db.add.rowY({ mark: 'keep-me' });

    await db.cascade.byField({
      collections: ['rowY'],
      filter: { mark: 'delete-me' },
      opts: { atomic: true }
    });

    const rest = await db.get.rowYS();
    expect(rest).toHaveLength(1);
    expect(rest[0].mark).toBe('keep-me');
    await db.disconnect();
  });

  test('expand throws when via is not a registered edge collection', async () => {
    const dir = path.join(root, 'expand-bad-via');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 44 } });
    db.schema('sEnt', { name: { type: String, required: true } });
    db.schema('sEdge', {
      from_id: { type: 'ref', to: 'sEnt', required: true },
      to_id:   { type: 'ref', to: 'sEnt', required: true },
      predicate: { type: String, required: true },
      $edge: {
        from: 'sEnt',
        to: 'sEnt',
        predicates: ['p'],
        predicate: 'predicate'
      }
    });
    const a = await db.add.sEnt({ name: 'Alice' });
    await expect(a.expand({ via: 'wrongEdgeName', hops: 1 })).rejects.toThrow(
      /not a registered edge collection/i
    );
    await db.disconnect();
  });

  test('expand direction both walks pickNextNode bilateral path', async () => {
    const dir = path.join(root, 'expand-both');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('eN', { name: { type: String, required: true } });
    db.schema('eEdge', {
      a: { type: 'ref', to: 'eN', required: true },
      b: { type: 'ref', to: 'eN', required: true },
      rel: { type: String, required: true },
      $edge: {
        from: 'eN',
        to: 'eN',
        predicates: ['relates'],
        predicate: 'rel'
      }
    });
    const x = await db.add.eN({ name: 'X' });
    const y = await db.add.eN({ name: 'Y' });
    await x.relates(y, { rel: 'r1' });

    const r = await x.expand({ via: 'eEdge', hops: 1, direction: 'both' });
    expect(r.complete).toBe(true);
    expect(r.nodes.some(n => n.name === 'Y')).toBe(true);

    const back = await y.expand({ via: 'eEdge', hops: 1, direction: 'both' });
    expect(back.nodes.some(n => n.name === 'X')).toBe(true);
    await db.disconnect();
  });

  test('expand budget.ms triggers time incompleteReason', async () => {
    const dir = path.join(root, 'expand-ms');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 56 } });
    db.schema('bEnt', { name: { type: String, required: true } });
    db.schema('bEdge', {
      u: { type: 'ref', to: 'bEnt', required: true },
      v: { type: 'ref', to: 'bEnt', required: true },
      predicate: { type: String, required: true },
      $edge: {
        from: 'bEnt',
        to: 'bEnt',
        predicates: ['link'],
        predicate: 'predicate'
      }
    });
    const hub = await db.add.bEnt({ name: 'hub' });
    for (let i = 0; i < 5; i++) {
      const leaf = await db.add.bEnt({ name: `L${i}` });
      await hub.link(leaf);
    }
    const r = await hub.expand({
      via: 'bEdge',
      hops: 4,
      budget: { ms: -1 }
    });
    expect(r.complete).toBe(false);
    expect(r.incompleteReason).toBe('time');
    await db.disconnect();
  });

  test('match with bounded index plus extra where field feeds match hydrate (index candidate path)', async () => {
    const dir = path.join(root, 'match-index-residual');
    await fs.mkdir(dir, { recursive: true });
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 56 } });
    db.schema('ixDoc', {
      kind: { type: String, required: true },
      body: { type: String, required: true },
      $indexes: [['kind']]
    });
    await db.add.ixDoc({ kind: 'a', body: 'find token-alpha here' });
    await db.add.ixDoc({ kind: 'a', body: 'other body' });
    await db.add.ixDoc({ kind: 'b', body: 'find token-alpha' });

    const hits = await db.get.ixDocS
      .where({ kind: 'a', body: 'find token-alpha here' })
      .match({ body: 'token' });

    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('a');
    await db.disconnect();
  });

  test('JSS round-trip: decode Error whose global constructor is not instanceof Error uses fallback factory', () => {
    const e = new Error('boom');
    e.name = 'Object';
    const out = JSS.parse(JSS.stringify({ err: e }));
    expect(out.err.message).toBe('boom');
    expect(out.err).toBeInstanceOf(Error);
  });

  test('JSS array round-trip preserves holes via Undefined tag decoding', () => {
    const out = JSS.parse(JSS.stringify([undefined, 7]));
    expect(out[1]).toBe(7);
  });

  test('isPartialMatch recursion false covers nested rejection', () => {
    expect(isPartialMatch({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
});

