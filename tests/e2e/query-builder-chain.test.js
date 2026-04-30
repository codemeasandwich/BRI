/**
 * @file Acceptance for the spec §2.2 chain-method completion on QueryBuilder.
 *
 * Covers methods added during Phase D of the typed-error / chain-method
 * migration: `.touching`, `.hydrate`, `.confidence`, `.history`,
 * `.withProvenance`, `.asOf`. Each test verifies:
 *   - schema-conditional gating (throws BriQueryError when the schema
 *     does not declare the matching $-flag)
 *   - the filter is actually applied to results
 *   - the metadata decoration (e.g. `$provenance`, `_<refField>`) lands
 *     on result entities as non-enumerable, read-only properties
 *
 * @implements spec §2.2 (chain methods)
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import { BriQueryError } from '../../src/engine/errors.js';
import fs from 'fs/promises';

const DIR = './test-data-qb-chain';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('QueryBuilder chain methods (spec §2.2 completion)', () => {
  let db;
  afterEach(async () => { if (db) await db.close?.(); });

  describe('.history (schema-conditional)', () => {
    test('throws when the collection does not declare $supersession', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      await db.add.thing({ name: 'one' });
      let thrown;
      try { await db.get.thingS.history.toArray(); }
      catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriQueryError);
      expect(thrown.code).toBe('SUPERSESSION_FIELD_NOT_DECLARED');
    });

    test('with $supersession, default hides superseded; .history shows all', async () => {
      db = await freshDB();
      // Self-ref via 'ref' type; $supersession names the field.
      db.schema('claim', {
        text:           { type: String, required: true },
        superseded_by:  { type: 'ref', to: 'claim', required: false },
        $supersession:  'superseded_by'
      });
      const a = await db.add.claim({ text: 'old' });
      const b = await db.add.claim({ text: 'new' });
      // Mark `a` as superseded by `b`.
      a.superseded_by = b.$ID;
      await a.save();

      const visible = await db.get.claimS.toArray();
      expect(visible.map(d => d.text).sort()).toEqual(['new']);

      const all = await db.get.claimS.history.toArray();
      expect(all.map(d => d.text).sort()).toEqual(['new', 'old']);
    });
  });

  describe('Group get-proxy symbol access', () => {
    test('symbol property access returns undefined (no implicit QueryBuilder)', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      const chainSym = Symbol('chain-prop');
      expect(db.get.thingS[chainSym]).toBeUndefined();
    });

    test('unknown string property bypasses QueryBuilder routing', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      expect(db.get.thingS.notAChainSurface).toBeUndefined();
    });
  });

  describe('.confidence (schema-conditional)', () => {
    test('throws when collection does not declare $confidence', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      await db.add.thing({ name: 'one' });
      expect(() => db.get.thingS.confidence(0.5)).toThrow(BriQueryError);
    });

    test('filters to docs with confidence ≥ threshold', async () => {
      db = await freshDB();
      db.schema('claim', {
        text:        { type: String, required: true },
        score:       { type: Number, required: false },
        $confidence: 'score'
      });
      await db.add.claim({ text: 'low',  score: 0.2 });
      await db.add.claim({ text: 'mid',  score: 0.7 });
      await db.add.claim({ text: 'high', score: 0.95 });

      const high = await db.get.claimS.confidence(0.8).toArray();
      expect(high.map(d => d.text).sort()).toEqual(['high']);
      const midhigh = await db.get.claimS.confidence(0.5).toArray();
      expect(midhigh.map(d => d.text).sort()).toEqual(['high', 'mid']);
    });
  });

  describe('.withProvenance (schema-conditional)', () => {
    test('throws when collection does not declare $provenance', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      await db.add.thing({ name: 'one' });
      let thrown;
      try { await db.get.thingS.withProvenance.toArray(); }
      catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriQueryError);
      expect(thrown.code).toBe('PROVENANCE_FIELD_NOT_DECLARED');
    });

    test('attaches $provenance metadata as a non-enumerable array', async () => {
      db = await freshDB();
      db.schema('claim', {
        text:           { type: String, required: true },
        sources:        { type: Array, items: String, required: false },
        $provenance:    'sources'
      });
      await db.add.claim({ text: 'hello', sources: ['turn_a', 'turn_b'] });
      const [row] = await db.get.claimS.withProvenance.toArray();
      expect(row.$provenance).toEqual(['turn_a', 'turn_b']);
      // Non-enumerable: should NOT be on Object.keys.
      expect(Object.keys(row)).not.toContain('$provenance');
    });

    test('scalar provenance source is wrapped once as single-element backing', async () => {
      db = await freshDB();
      db.schema('claim', {
        text:        { type: String, required: true },
        sourceTag: { type: String, required: false },
        $provenance: 'sourceTag'
      });
      await db.add.claim({ text: 'one', sourceTag: 'turn_a' });
      const [row] = await db.get.claimS.withProvenance.toArray();
      expect(row.$provenance).toEqual(['turn_a']);
    });

    test('missing provenance field yields empty $provenance decorate slot', async () => {
      db = await freshDB();
      db.schema('claim', {
        text:        { type: String, required: true },
        sourceTag: { type: String, required: false },
        $provenance: 'sourceTag'
      });
      await db.add.claim({ text: 'no-sources' });
      const [row] = await db.get.claimS.withProvenance.toArray();
      expect(row.$provenance).toEqual([]);
    });
  });

  describe('.hydrate (UC-X1)', () => {
    test('resolves named ref fields into _<field> attached to each row', async () => {
      db = await freshDB();
      db.schema('user', { name: { type: String, required: true } });
      db.schema('post', {
        title:  { type: String, required: true },
        author: { type: 'ref', to: 'user', required: true }
      });
      const alice = await db.add.user({ name: 'Alice' });
      await db.add.post({ title: 'first', author: alice.$ID });
      await db.add.post({ title: 'second', author: alice.$ID });

      const rows = await db.get.postS.hydrate(['author']).toArray();
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row._author).toBeDefined();
        expect(row._author.name).toBe('Alice');
        // Original ref preserved, new field is non-enumerable
        expect(row.author).toBe(alice.$ID);
        expect(Object.keys(row)).not.toContain('_author');
      }
    });

    test('skips hydrate when ref-like string field is empty', async () => {
      db = await freshDB();
      db.schema('post', {
        title:      { type: String, required: true },
        externalId: { type: String, required: false }
      });
      const r = await db.add.post({
        title: 'no-external',
        externalId: ''
      });
      const rows = await db.get.postS.hydrate(['externalId']).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]._externalId).toBeUndefined();
      expect(rows[0].$ID).toBe(r.$ID);
    });
  });

  describe('.touching (UC-G1, edge-collection only)', () => {
    test('throws on non-edge collections', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      await db.add.thing({ name: 'one' });
      let thrown;
      try { await db.get.thingS.touching(['NONE_aaaaaaa']).toArray(); }
      catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriQueryError);
      expect(thrown.code).toBe('TOUCHING_NOT_AN_EDGE_COLLECTION');
    });

    test('returns edges adjacent to any seed', async () => {
      db = await freshDB();
      db.schema('node', { name: { type: String, required: true } });
      db.schema('edge', {
        from_id: { type: 'ref', to: 'node', required: true },
        to_id:   { type: 'ref', to: 'node', required: true },
        kind:    { type: String, required: true },
        $edge:   { from: 'node', to: 'node', predicate: 'kind', predicates: '*' }
      });
      const a = await db.add.node({ name: 'a' });
      const b = await db.add.node({ name: 'b' });
      const c = await db.add.node({ name: 'c' });
      await db.add.edge({ from_id: a.$ID, to_id: b.$ID, kind: 'links' });
      await db.add.edge({ from_id: b.$ID, to_id: c.$ID, kind: 'links' });
      // a-b (touches a or b), b-c (touches b or c) → seeds=[a]: only a-b.
      const edges = await db.get.edgeS.touching([a.$ID]).toArray();
      expect(edges.length).toBe(1);
      expect(edges[0].from_id).toBe(a.$ID);
      expect(edges[0].to_id).toBe(b.$ID);
      // seeds=[b]: both edges touch b
      const both = await db.get.edgeS.touching([b.$ID]).toArray();
      expect(both.length).toBe(2);
    });
  });

  describe('Terminals (.first / .count / .distinct)', () => {
    const DIM = 4;
    /** Deterministic cosine-normalised vector for UC-V terminals */
    function mkVec(seed) {
      const out = [];
      let h = seed;
      let mag = 0;
      for (let i = 0; i < DIM; i++) {
        h = (h * 1103515245 + i) >>> 0;
        const x = ((h % 1000) / 1000) - 0.5;
        out.push(x);
        mag += x * x;
      }
      const n = Math.sqrt(mag) || 1;
      for (let i = 0; i < DIM; i++) out[i] /= n;
      return out;
    }

    test('.first resolves null when the filter yields no rows', async () => {
      db = await freshDB();
      db.schema('acct', {
        slug: { type: String, required: true },
        amt: { type: Number, required: false },
      });
      await db.add.acct({ slug: 'a', amt: 1 });
      const row = await db.get.acctS.where({ slug: 'nosuch' }).first();
      expect(row).toBeNull();
    });

    test('.count rejects when chained after .near (COUNT_NEAR_UNSUPPORTED)', async () => {
      db = await freshDB();
      db.schema('embeddingRow', {
        label: { type: String, required: true },
        emb: { type: 'vector', dims: DIM, required: false },
      });
      await db.add.embeddingRow({ label: 'x', emb: mkVec(10) });
      const qb = db.get.embeddingRowS.where({ label: 'x' }).near(mkVec(44), 2);
      let thrown;
      try {
        await qb.count();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BriQueryError);
      expect(thrown.code).toBe('COUNT_NEAR_UNSUPPORTED');
    });

    test('.distinct rejects when chained after .near (DISTINCT_NEAR_UNSUPPORTED)', async () => {
      db = await freshDB();
      db.schema('embeddingRow2', {
        label: { type: String, required: true },
        emb: { type: 'vector', dims: DIM, required: false },
      });
      await db.add.embeddingRow2({ label: 'dup', emb: mkVec(2) });
      const qb = db.get.embeddingRow2S.where({ label: 'dup' }).near(mkVec(3), 2);
      let thrown;
      try {
        await qb.distinct('label');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BriQueryError);
      expect(thrown.code).toBe('DISTINCT_NEAR_UNSUPPORTED');
    });

    test('.distinct de-duplicates same field across many rows', async () => {
      db = await freshDB();
      db.schema('event', {
        kind: { type: String, required: true },
        score: { type: Number, required: false },
      });
      await db.add.event({ kind: 'click', score: 1 });
      await db.add.event({ kind: 'click', score: 2 });
      await db.add.event({ kind: 'hover', score: 0 });
      const kinds = await db.get.eventS.where({}).distinct('kind');
      expect(kinds.slice().sort()).toEqual(['click', 'hover']);
    });
  });

  describe('.asOf (deferred to v2)', () => {
    test('throws BriQueryError NOT_IMPLEMENTED_V1', async () => {
      db = await freshDB();
      db.schema('thing', { name: { type: String, required: true } });
      let thrown;
      try { db.get.thingS.asOf(new Date()); }
      catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriQueryError);
      expect(thrown.code).toBe('NOT_IMPLEMENTED_V1');
    });
  });
});
