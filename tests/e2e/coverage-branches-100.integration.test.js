/**
 * @file Remaining Istanbul branch arms that require explicit user-level flows.
 * Exercises createDB, createStore (inhouse), WAL, helpers, and txn manager.
 */

import fs from 'fs/promises';
import path from 'path';
import { createDB } from '../../client/index.js';
import { createStore } from '../../storage/index.js';
import { createSetEntry, serializeEntryEncrypted } from '../../storage/wal/entry.js';
import { WALReader } from '../../storage/wal/reader.js';
import { ensureTopology, dropNode } from '../../engine/vector-index-hnsw-state.js';
import { type2Short } from '../../engine/types.js';
import { vectorIndexMiddleware } from '../../engine/vector-middleware.js';

const BASE = './test-data-branches-100';

async function rmDir(d) {
  await fs.rm(d, { recursive: true, force: true }).catch(() => {});
}

describe('Branch coverage 100% — integration', () => {
  beforeEach(async () => rmDir(BASE));

  test('fin commits a non-active txn without clearing the current active txn', async () => {
    const dir = `${BASE}-fin-na`;
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('x', { n: { type: Number } });
    const txnA = db.rec();
    await db.add.x({ n: 1 });
    const txnB = db.rec();
    await db.add.x({ n: 2 });
    await db.fin(txnA);
    expect(db._activeTxnId).toBe(txnB);
    await db.fin(txnB);
    await db.disconnect();
  });

  test('pop SET skips non-matching vector collections then matches prefix', async () => {
    const dir = `${BASE}-pop-vec2`;
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('vecOne', { emb: { type: 'vector', dims: 2 } });
    db.schema('vecTwo', { emb: { type: 'vector', dims: 2 } });
    db.rec();
    const a = await db.add.vecOne({ emb: [1, 0] });
    const p = a.$ID.split('_')[0];
    expect(p).toBe(type2Short('vecOne'));
    // First pop is typically SADD; second pop is SET — vector hook runs on SET.
    await db.pop();
    await db.pop();
    await db.fin();
    await db.disconnect();
  });

  test('cascade.byField without atomic does not nop when del throws', async () => {
    const dir = `${BASE}-cascade-catch`;
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('cRow', { k: { type: String } });
    await db.add.cRow({ k: 'hit' });
    const fault = async (ctx, next) => {
      if (ctx.operation === 'del' && ctx.type === 'cRow') {
        throw new Error('cascade del fault');
      }
      return next();
    };
    db.use(fault);
    await expect(
      db.cascade.byField({ collections: ['cRow'], filter: { k: 'hit' } })
    ).rejects.toThrow(/cascade del fault/);
    db.middleware.remove(fault);
    await db.disconnect();
  });

  test('reactive save uses numeric saveByOrOpts without string branch', async () => {
    const dir = `${BASE}-rx-num`;
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('rxN', { v: { type: String } });
    const d = await db.add.rxN({ v: 'a' });
    d.v = 'b';
    await d.save(0);
    const back = await db.get.rxN(d.$ID);
    expect(back.v).toBe('b');
    await db.disconnect();
  });

  test('ensureTopology leaves backing arrays when already at capacity', () => {
    const idx = {
      _capacity: 4,
      _levels: new Int32Array(4),
      _neighbors: new Array(4).fill(null)
    };
    idx._levels.fill(-1);
    ensureTopology(idx);
    expect(idx._levels.length).toBe(4);
  });

  test('vector index drift uses (ps.metric||cosine) when persisted metric omitted', async () => {
    const dir = `${BASE}-vdrift`;
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db.schema('vdr', { e: { type: 'vector', dims: 2 } });
    await db.disconnect();
    const db2 = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 48 } });
    db2.schema('vdr', { e: { type: 'vector', dims: 2 } });
    const ent = db2._store.getVectorEntry('vdr');
    expect(ent).toBeDefined();
    delete ent.schema.metric;
    expect(() =>
      db2.schema('vdr', {
        e: { type: 'vector', dims: 2, metric: 'euclidean' }
      })
    ).toThrow(/Vector index drift|metric/i);
    await db2.disconnect();
  });

  test('serializeEntryEncrypted default prevPointer and WALReader readEntries default line', async () => {
    const dir = `${BASE}-wal-def`;
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const key = Buffer.alloc(32, 7);
    const line = serializeEntryEncrypted(createSetEntry('K_x', '{}'), key);
    const walFile = path.join(dir, 'wal', '000000.wal');
    await fs.writeFile(walFile, line + '\n', 'utf8');
    const reader = new WALReader(path.join(dir, 'wal'), { encryptionKey: key });
    let n = 0;
    for await (const _ of reader.readEntries()) {
      n++;
      break;
    }
    expect(n).toBe(1);
  });

  test('inhouse coldLoader skips cold delete when readDoc returns null', async () => {
    const dir = `${BASE}-cold-null`;
    const store = await createStore({
      type: 'inhouse',
      config: {
        dataDir: dir,
        maxMemoryMB: 0.001,
        evictionThreshold: 0.4
      }
    });
    const body = JSON.stringify({ data: 'y'.repeat(800) });
    await store.set('CLDR_k1', body);
    await store.set('CLDR_k2', body);
    let coldKey = null;
    for (const [k, e] of store.hotTier.documents) {
      if (e && e.cold) {
        coldKey = k;
        break;
      }
    }
    expect(coldKey).toBeTruthy();
    const type = coldKey.split('_')[0];
    const idPart = coldKey.slice(type.length + 1);
    const ghost = path.join(dir, 'cold', type, `${idPart}.jss`);
    await fs.unlink(ghost);
    const got = await store.get(coldKey);
    expect(got).toBeNull();
    await store.disconnect();
  });

  test('dropNode re-election hits level tie (inner if else arm)', () => {
    const index = {
      _capacity: 3,
      _idAt: [null, 'id1', 'id2'],
      _levels: new Int32Array([-1, 3, 3]),
      _neighbors: new Array(3).fill(null),
      _entryPoint: 0,
      _entryLevel: 3
    };
    dropNode(index, 0);
    expect(index._entryPoint).toBe(1);
    expect(index._entryLevel).toBe(3);
  });

  /**
   * Drives POST-sync branches in vector-middleware with the real registry and
   * synthetic ctx objects — same function the DB wires.
   */
  test('vectorIndexMiddleware entity / prefetch / secondary / graph conditional arms', async () => {
    const dir = `${BASE}-vmx`;
    const db = await createDB({ storeConfig: { dataDir: dir, maxMemoryMB: 64 } });
    db.schema('midNode', { name: { type: String } });
    db.schema('midEdge', {
      from_id: { type: 'ref', to: 'midNode', required: true },
      to_id: { type: 'ref', to: 'midNode', required: true },
      predicate: { type: String, required: true },
      $edge: {
        from: 'midNode',
        to: 'midNode',
        predicate: 'predicate',
        predicates: '*'
      }
    });
    db.schema('midVec', {
      emb: { type: 'vector', dims: 2 }
    });
    db.schema('midSec', {
      tag: { type: String },
      $indexes: [['tag']]
    });

    const mw = vectorIndexMiddleware(db._registry);

    const ctxSetNoId = {
      operation: 'set',
      type: 'midSec',
      args: [{ tag: 'solo' }],
      opts: {},
      db,
      result: undefined
    };
    await mw(ctxSetNoId, async () => {
      ctxSetNoId.result = { $ID: 'MID_s1', tag: 'solo' };
    });

    await mw(
      {
        operation: 'del',
        type: 'midVec',
        args: [{}],
        opts: {},
        db,
        result: null
      },
      async () => {}
    );

    const ctxAddSec = {
      operation: 'add',
      type: 'midSec',
      args: [{ tag: 'only' }],
      opts: {},
      db,
      result: undefined
    };
    await mw(ctxAddSec, async () => {
      ctxAddSec.result = { tag: 'only' };
    });

    const ctxSetSecNoEntityId = {
      operation: 'set',
      type: 'midSec',
      args: [{ $ID: 'MID_x', tag: 'b' }],
      opts: {},
      db,
      result: undefined
    };
    await mw(ctxSetSecNoEntityId, async () => {
      ctxSetSecNoEntityId.result = { tag: 'b' };
    });

    await mw(
      {
        operation: 'del',
        type: 'midSec',
        args: ['MID_z'],
        opts: {},
        db: {
          get: {
            midSec: async () => null
          }
        },
        result: null
      },
      async () => {}
    );

    const nLeft = await db.add.midNode({ name: 'L' });
    const nRight = await db.add.midNode({ name: 'R' });

    const ctxEdgeAddNoId = {
      operation: 'add',
      type: 'midEdge',
      args: [
        {
          from_id: nLeft.$ID,
          to_id: nRight.$ID,
          predicate: 'rel'
        }
      ],
      opts: {},
      db,
      result: undefined
    };
    await mw(ctxEdgeAddNoId, async () => {
      ctxEdgeAddNoId.result = {};
    });

    const ctxEdgeSetPrefetchNull = {
      operation: 'set',
      type: 'midEdge',
      args: [
        {
          $ID: 'E_edge1',
          from_id: nLeft.$ID,
          to_id: nRight.$ID,
          predicate: 'p'
        }
      ],
      opts: {},
      db: {
        get: {
          midEdge: async () => null
        }
      },
      result: undefined
    };
    await mw(ctxEdgeSetPrefetchNull, async () => {
      ctxEdgeSetPrefetchNull.result = {
        $ID: 'E_edge1',
        from_id: nLeft.$ID,
        to_id: nRight.$ID,
        predicate: 'p'
      };
    });

    /** Graph index set branch when entity exists without $ID (skipped insert/remove preDoc path). */
    const ctxEdgeSetNoGraphId = {
      operation: 'set',
      type: 'midEdge',
      args: [
        {
          $ID: 'E_nomatch',
          from_id: nLeft.$ID,
          to_id: nRight.$ID,
          predicate: 'edgeNoIdResult'
        }
      ],
      opts: {},
      db,
      result: undefined
    };
    await mw(ctxEdgeSetNoGraphId, async () => {
      ctxEdgeSetNoGraphId.result = {
        from_id: nLeft.$ID,
        to_id: nRight.$ID,
        predicate: 'edgeNoIdResult'
      };
    });

    await mw(
      {
        operation: 'del',
        type: 'midEdge',
        args: ['E_edge1'],
        opts: {},
        db: {
          get: {
            midEdge: async () => ({ ghost: true })
          }
        },
        result: null
      },
      async () => {}
    );

    await db.disconnect();
  });
});
