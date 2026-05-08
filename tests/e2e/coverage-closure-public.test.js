/**
 * @file Public-surface coverage closure for database hardening paths.
 *
 * These scenarios intentionally drive Bri through READY database handles and
 * package-level storage/engine exports. The goal is to exercise resilience,
 * transaction, graph, WAL, and identity paths as an embedding application would,
 * without changing production code or weakening the repository coverage gate.
 */

import fs from 'fs/promises';
import path from 'path';
import { openLocalDatabase } from '../../index.js';
import { createStore, WALWriter } from '../../src/storage/index.js';
import { createDeleteEntry, createSetEntry } from '../../src/storage/wal/entry.js';
import { createSchemaRegistry } from '../../src/engine/schema-registry.js';
import {
  applyBetweenConstraint,
  betweenCandidateIds
} from '../../src/client/query-builder-residual.js';
import { createSchemaRegistryIdentity } from '../../src/engine/schema-registry-identity.js';
import {
  bindGraphIndexToStore,
  canonicalPairKeyFor,
  rebuildAdjacencyFromHot
} from '../../src/engine/canonical-pair.js';
import { collectionIdentityDiagnostics } from '../../src/engine/collection-identity.js';
import { ppr } from '../../src/engine/graph-algo-ppr.js';
import { createAlgo } from '../../src/engine/graph-algo.js';
import { SecondaryIndexManager } from '../../src/engine/secondary-index.js';
import { logTxnOp, popStagedOp, rollbackTxn } from '../../src/engine/secondary-index-txn.js';
import { vectorIndexMiddleware } from '../../src/engine/vector-middleware.js';
import { rebuildTopology } from '../../src/engine/vector-index-hnsw-state.js';
import {
  chooseSnapshotVersion,
  collectionIdentitySnapshotState
} from '../../src/storage/adapters/inhouse-snapshot-version.js';
import { GraphIndex, type2Short } from '../../src/engine/index.js';
import { refToId } from '../../src/engine/helpers.js';
import JSS from '../../src/utils/jss/index.js';

const BASE = './test-data-coverage-closure-public';

/**
 * Remove one test data directory so every scenario boots from a known state.
 *
 * @param {string} dir - Directory to remove recursively.
 * @returns {Promise<void>}
 */
async function clean(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Open a quiet local database for blackbox workflow tests.
 *
 * @param {string} dir - Durable storage directory for the scenario.
 * @returns {Promise<Object>} READY Bri database.
 */
function openDb(dir) {
  return openLocalDatabase({
    logger: false,
    storeConfig: { dataDir: dir, maxMemoryMB: 64, walSegmentSize: 256 }
  });
}

/**
 * Declare a graph schema with indexed symmetric edges for `.between`,
 * PPR, and transaction-index workflows.
 *
 * @param {Object} db - READY database.
 */
function declareGraphSchema(db) {
  db.schema('coverNode', { name: { type: String, required: true } });
  db.schema('coverEdge', {
    from_id: { type: 'ref', to: 'coverNode', required: true },
    to_id: { type: 'ref', to: 'coverNode', required: true },
    weight: { type: Number, required: false },
    tag: { type: String, required: false },
    $edge: { from: 'coverNode', to: 'coverNode', symmetric: true, unique: true },
    $indexes: [['weight'], ['tag']]
  });
}

describe('Public coverage closure scenarios', () => {
  beforeEach(async () => clean(BASE));
  afterEach(async () => clean(BASE));

  test('indexed between queries intersect planner candidates and handle empty canonical lookups', async () => {
    const db = await openDb(`${BASE}-between`);
    try {
      declareGraphSchema(db);
      const a = await db.add.coverNode({ name: 'a' });
      const b = await db.add.coverNode({ name: 'b' });
      const c = await db.add.coverNode({ name: 'c' });
      const edge = await db.add.coverEdge({
        from_id: a.$ID,
        to_id: b.$ID,
        weight: 7,
        tag: 'kept'
      });

      const hit = await db.get.coverEdgeS
        .where({ weight: 7 })
        .between(a, b)
        .first();
      expect(hit.$ID).toBe(edge.$ID);

      const filteredOut = await db.get.coverEdgeS
        .where({ weight: 999 })
        .between(a, b)
        .first();
      expect(filteredOut).toBeNull();

      const noPair = await db.get.coverEdgeS.between(a, c).first();
      expect(noPair).toBeNull();
      expect(() => db.get.coverEdgeS.between(null, c)).toThrow(/nodeA and nodeB/);
    } finally {
      await db.disconnect();
    }
  });

  test('query-builder exported constraints cover defensive candidate branches', () => {
    const plan = { useIndex: true, candidateIds: new Set(['EDGE_keep', 'EDGE_drop']) };
    applyBetweenConstraint(plan, new Set(['EDGE_keep']));
    expect([...plan.candidateIds]).toEqual(['EDGE_keep']);

    const edgeSpec = { from: 'from_id', to: 'to_id' };
    expect(betweenCandidateIds({
      collection: 'edge',
      registry: {
        edgeSpec: () => edgeSpec,
        canonicalPairKey: () => null,
        secondaryIndexManager: () => ({})
      }
    }, { aId: 'A', bId: 'B' })).toEqual(new Set());
    expect(betweenCandidateIds({
      collection: 'edge',
      registry: {
        edgeSpec: () => edgeSpec,
        canonicalPairKey: () => ['A', 'B']
      }
    }, { aId: 'A', bId: 'B' })).toEqual(new Set());
    expect(betweenCandidateIds({
      collection: 'edge',
      registry: {
        edgeSpec: () => edgeSpec,
        canonicalPairKey: () => ['A', 'B'],
        secondaryIndexManager: () => ({ candidatesFor: () => null })
      }
    }, { aId: 'A', bId: 'B' })).toEqual(new Set());
  });

  test('PPR handles symmetric edges, malformed persisted rows, and hydration failures', async () => {
    const db = await openDb(`${BASE}-ppr`);
    try {
      declareGraphSchema(db);
      const a = await db.add.coverNode({ name: 'a' });
      const b = await db.add.coverNode({ name: 'b' });
      const edgePrefix = type2Short('coverEdge');
      const nodePrefix = type2Short('coverNode');
      const mismatchedId = `${type2Short('otherNode')}_ghost`;
      const badNodeKey = `${nodePrefix}_ghost`;
      const noIdEdge = `${edgePrefix}_noid`;
      const badEndpointEdge = `${edgePrefix}_badend`;

      await db.add.coverEdge({
        from_id: a.$ID,
        to_id: b.$ID,
        weight: 2,
        tag: 'valid'
      });
      await db._store.set(badNodeKey, JSS.stringify({ $ID: mismatchedId, name: 'ghost' }));
      await db._store.sAdd(`${nodePrefix}?`, 'ghost');
      await db._store.set(noIdEdge, JSS.stringify({ from_id: a.$ID, to_id: b.$ID, weight: 1 }));
      await db._store.sAdd(`${edgePrefix}?`, 'noid');
      await db._store.set(badEndpointEdge, JSS.stringify({
        $ID: badEndpointEdge,
        from_id: a.$ID,
        weight: 1
      }));
      await db._store.sAdd(`${edgePrefix}?`, 'badend');
      await db._store.set(`${edgePrefix}_ghost`, JSS.stringify({
        $ID: `${edgePrefix}_ghost`,
        from_id: a.$ID,
        to_id: mismatchedId,
        weight: 3
      }));
      await db._store.sAdd(`${edgePrefix}?`, 'ghost');

      await expect(db.algo.ppr({
        collection: 'coverNode',
        via: 'coverNode',
        seeds: [a]
      })).rejects.toThrow(/not a registered edge collection/);

      const rows = await db.algo.ppr({
        collection: 'coverNode',
        via: 'coverEdge',
        seeds: [a],
        top: 10,
        edgeFilter: () => true,
        weightField: 'weight',
        iterations: 3,
        epsilon: 0
      });
      expect(rows.map((row) => row.entity.$ID)).toContain(a.$ID);
      expect(rows.map((row) => row.entity.$ID)).toContain(b.$ID);
      expect(rows.some((row) => row.entity.$ID === mismatchedId)).toBe(false);
    } finally {
      await db.disconnect();
    }
  });

  test('secondary indexes roll back and pop remove/update actions through database transactions', async () => {
    const db = await openDb(`${BASE}-secondary-txn`);
    try {
      db.schema('coverIndexed', {
        tag: { type: String, required: true },
        label: { type: String, required: false },
        $indexes: [['tag']]
      });

      const removeRollback = await db.add.coverIndexed({ tag: 'remove-rollback' });
      db.rec();
      await db.del.coverIndexed(removeRollback.$ID, 'COVR_tester');
      await db.nop();
      await expect(db.get.coverIndexed(removeRollback.$ID)).resolves.toBeDefined();

      const updateRollback = await db.add.coverIndexed({ tag: 'before-update' });
      db.rec();
      updateRollback.tag = 'after-update';
      await updateRollback.save();
      await db.nop();
      expect(await db.get.coverIndexedS.where({ tag: 'after-update' }).first()).toBeNull();
      expect((await db.get.coverIndexedS.where({ tag: 'before-update' }).first()).$ID)
        .toBe(updateRollback.$ID);

      const removePop = await db.add.coverIndexed({ tag: 'remove-pop' });
      db.rec();
      await db.del.coverIndexed(removePop.$ID, 'COVR_tester');
      await db.pop();
      await expect(db.get.coverIndexed(removePop.$ID)).resolves.toBeDefined();
      await db.nop();

      const updatePop = await db.add.coverIndexed({ tag: 'pop-before' });
      db.rec();
      updatePop.tag = 'pop-after';
      await updatePop.save();
      await db.pop();
      expect(await db.get.coverIndexedS.where({ tag: 'pop-after' }).first()).toBeNull();
      expect((await db.get.coverIndexedS.where({ tag: 'pop-before' }).first()).$ID)
        .toBe(updatePop.$ID);
      await db.nop();
    } finally {
      await db.disconnect();
    }
  });

  test('storage and WAL exported surfaces exercise logger propagation and descriptor races', async () => {
    const store = await createStore({
      logger: false,
      config: {
        dataDir: `${BASE}-store`,
        maxMemoryMB: 32,
        logger: false,
        fsyncMode: 'always'
      }
    });
    await store.set('CLOS_a', JSS.stringify({ $ID: 'CLOS_a', value: 1 }));
    expect(await store.get('CLOS_a')).toContain('value');
    await store.disconnect();

    const walDir = path.join(`${BASE}-wal`, 'wal');
    await fs.mkdir(walDir, { recursive: true });
    const writer = new WALWriter(walDir, {
      segmentSize: 128,
      fsyncMode: 'manual',
      logger: false
    });
    await writer.init();
    await writer.openSegment();
    await writer.append(createSetEntry('WAL_a', 'a'.repeat(160)));
    const handle = writer.fileHandle;
    await handle.close();
    await writer.close();
  });

  test('exported identity and graph helpers cover collision and no-store branches', async () => {
    const registry = createSchemaRegistry();
    registry.declare('alpha', { value: { type: String } });
    expect(() => registry.declare('alpineHa', { value: { type: String } }))
      .toThrow(/storage identity collision/i);

    const identity = createSchemaRegistryIdentity();
    identity.declare('alpha');
    expect(() => identity.register('alpineHa'))
      .toThrow(/storage identity collision/i);

    const graphIndex = new GraphIndex();
    expect(graphIndex.hasAdjacencyFor('none')).toBe(false);
  });

  test('exported engine helpers cover defensive graph and identity branches', async () => {
    expect(canonicalPairKeyFor(null, {})).toBeNull();
    expect(canonicalPairKeyFor({ from: 'from_id', to: 'to_id' }, { from_id: 'A' })).toBeNull();
    expect(bindGraphIndexToStore(null, new GraphIndex())).toBeUndefined();
    expect(rebuildAdjacencyFromHot(null, new GraphIndex(), 'edge', 'EDGE')).toBe(0);
    expect(refToId({ not: '$ID' })).toBeNull();

    const graph = new GraphIndex();
    graph._incoming.set('incomingOnly', new Map([['NODE_a', new Map()]]));
    expect(graph.hasAdjacencyFor('incomingOnly')).toBe(true);

    const diagnostics = collectionIdentityDiagnostics(
      new Map([['alpha', 'ALHA']]),
      undefined,
      type2Short
    );
    expect(diagnostics).toEqual([expect.objectContaining({ collection: 'alpha' })]);
    const repeated = collectionIdentityDiagnostics(
      new Map([['alpha', 'ALHA']]),
      ['alpha'],
      type2Short
    );
    expect(repeated).toEqual([expect.objectContaining({ collection: 'alpha' })]);

    const directIdentity = createSchemaRegistryIdentity({
      getCollectionIdentities: () => new Map([['alpha', 'ALHA']]),
      registerCollectionIdentity: () => {},
      ensureCollectionIdentity: async () => {},
      assertCollectionIdentity: () => {}
    });
    expect(directIdentity.declare('alpha')).toBe('ALHA');
    await expect(directIdentity.ensure('alpha')).resolves.toBeUndefined();
    expect(() => directIdentity.assert('alpha')).not.toThrow();
    expect(directIdentity.diagnostics(['alpha'])).toEqual([
      expect.objectContaining({ collection: 'alpha' })
    ]);

    const localIdentity = createSchemaRegistryIdentity();
    await expect(localIdentity.ensure('alpha')).resolves.toBe(true);
    await expect(localIdentity.ensure('alpha')).resolves.toBe(false);
    expect(() => localIdentity.assert('alpha')).not.toThrow();
    expect(localIdentity.diagnostics()).toEqual([
      expect.objectContaining({ collection: 'alpha' })
    ]);
    await localIdentity.forget('alpha');
    await localIdentity.forget('alpha');

    expect(createSchemaRegistry().collectionIdentityDiagnostics()).toEqual([]);
  });

  test('PPR fallback path runs without storage fast-path and handles empty or invalid seed universes', async () => {
    const nodes = [{ $ID: 'NODE_a' }, null];
    const edges = [{ $ID: 'EDGE_ab', from_id: 'NODE_a', to_id: 'NODE_b' }];
    const fakeDb = {
      get: {
        coverNodeS: async () => nodes,
        coverEdgeS: async () => edges,
        coverNode: async (id) => ({ $ID: id })
      },
      _store: {}
    };
    const registry = {
      edgeSpec: () => ({ from: 'from_id', to: 'to_id', symmetric: false })
    };

    expect(await ppr({
      collection: 'coverNode',
      via: 'coverEdge',
      seeds: [null],
      registry,
      getDb: () => fakeDb
    })).toEqual([]);
    expect(await ppr({
      collection: 'coverNode',
      via: 'coverEdge',
      seeds: ['NODE_a'],
      damping: 0.5,
      registry,
      getDb: () => ({ ...fakeDb, get: { ...fakeDb.get, coverNodeS: async () => [] } })
    })).toEqual([]);
  });

  test('graph rebuild and secondary-index transaction helpers cover update/removal undo paths', async () => {
    const idx = new SecondaryIndexManager();
    idx.declare('coverIndexed', [['tag']]);
    logTxnOp(idx, 'txn_existing_log', {
      op: 'insert',
      collection: 'coverIndexed',
      doc: { $ID: 'DOC_one', tag: 'one' }
    });
    logTxnOp(idx, 'txn_existing_log', {
      op: 'insert',
      collection: 'coverIndexed',
      doc: { $ID: 'DOC_two', tag: 'two' }
    });
    popStagedOp(idx, 'txn_existing_log', 'DOC_missing');
    popStagedOp(idx, 'txn_existing_log', 'DOC_two');

    logTxnOp(idx, 'txn_rollback_non_update', {
      op: 'noop',
      collection: 'coverIndexed',
      doc: { $ID: 'DOC_noop', tag: 'noop' }
    });
    rollbackTxn(idx, 'txn_rollback_non_update');
    logTxnOp(idx, 'txn_pop_noop', {
      op: 'noop',
      collection: 'coverIndexed',
      doc: { $ID: 'DOC_pop_noop', tag: 'noop-pop' }
    });
    popStagedOp(idx, 'txn_pop_noop', 'DOC_pop_noop');

    idx.insert('coverIndexed', { $ID: 'DOC_old', tag: 'old' });
    idx.update(
      'coverIndexed',
      { $ID: 'DOC_old', tag: 'old' },
      { $ID: 'DOC_old', tag: 'new' },
      'txn_direct'
    );
    rollbackTxn(idx, 'txn_direct');
    expect(idx.candidatesFor('coverIndexed', { tag: 'old' }).ids).toContain('DOC_old');

    idx.insert('coverIndexed', { $ID: 'DOC_removed', tag: 'removed' });
    idx.remove('coverIndexed', { $ID: 'DOC_removed', tag: 'removed' }, 'txn_pop_remove');
    popStagedOp(idx, 'txn_pop_remove', 'DOC_removed');
    expect(idx.candidatesFor('coverIndexed', { tag: 'removed' }).ids).toContain('DOC_removed');

    idx.insert('coverIndexed', { $ID: 'DOC_changed', tag: 'before' });
    idx.update(
      'coverIndexed',
      { $ID: 'DOC_changed', tag: 'before' },
      { $ID: 'DOC_changed', tag: 'after' },
      'txn_pop_update'
    );
    popStagedOp(idx, 'txn_pop_update', 'DOC_changed');
    expect(idx.candidatesFor('coverIndexed', { tag: 'before' }).ids).toContain('DOC_changed');

    idx.insert('coverIndexed', { $ID: 'DOC_insert_pop', tag: 'insert-pop' });
    logTxnOp(idx, 'txn_pop_insert', {
      op: 'insert',
      collection: 'coverIndexed',
      doc: { $ID: 'DOC_insert_pop', tag: 'insert-pop' }
    });
    popStagedOp(idx, 'txn_pop_insert', 'DOC_insert_pop');
    expect(idx.candidatesFor('coverIndexed', { tag: 'insert-pop' }).ids).toEqual([]);

    const algo = createAlgo({
      registry: {
        needsCanonicalPair: () => false,
        secondaryIndexManager: () => idx
      },
      getDb: () => ({ get: { coverEdgeS: async () => [] } })
    });
    await expect(algo.rebuildCanonicalPair({})).rejects.toThrow(/requires/);
    await expect(algo.rebuildCanonicalPair({ collection: 'plainEdge' }))
      .rejects.toThrow(/not declared/);

    const rebuildIdx = new SecondaryIndexManager();
    rebuildIdx.declare('coverEdge', [['__edgePair']]);
    const rebuildAlgo = createAlgo({
      registry: {
        needsCanonicalPair: () => true,
        canonicalPairKey: (_collection, edge) => edge?.from_id && edge?.to_id
          ? [edge.from_id, edge.to_id]
          : null,
        secondaryIndexManager: () => rebuildIdx
      },
      getDb: () => ({
        get: {
          coverEdgeS: async () => [
            null,
            { $ID: 'EDGE_missing_pair' },
            { $ID: 'EDGE_plain', from_id: 'A', to_id: 'B' }
          ]
        }
      })
    });
    await expect(rebuildAlgo.rebuildCanonicalPair({ collection: 'coverEdge' }))
      .resolves.toEqual({ collection: 'coverEdge', indexed: 1 });
  });

  test('vector middleware exported path handles non-object and no-pair canonical candidates', async () => {
    const registry = createSchemaRegistry();
    registry.declare('coverNode', { name: { type: String } });
    registry.declare('coverEdge', {
      from_id: { type: 'ref', to: 'coverNode', required: false },
      to_id: { type: 'ref', to: 'coverNode', required: false },
      $edge: { from: 'coverNode', to: 'coverNode', symmetric: true, unique: true }
    });
    const mw = vectorIndexMiddleware(registry);
    await mw({
      operation: 'add',
      type: 'coverEdge',
      args: ['not-an-object'],
      opts: {},
      result: null
    }, async () => {});
    await mw({
      operation: 'add',
      type: 'coverEdge',
      args: [{ from_id: 'COVN_abcdefg' }],
      opts: {},
      result: { $ID: 'COVR_bad', from_id: 'COVN_abcdefg' }
    }, async () => {});
    await mw({
      operation: 'set',
      type: 'coverEdge',
      args: [{ $ID: 'COVR_abcdefg', from_id: 'COVN_abcdefg', to_id: 'COVN_bcdefgh' }],
      opts: {},
      result: { $ID: 'COVR_abcdefg', from_id: 'COVN_abcdefg', to_id: 'COVN_bcdefgh' }
    }, async () => {});

    registry.secondaryIndexManager().insert('coverEdge', {
      $ID: 'COVR_existing',
      __edgePair: ['COVN_abcdefg', 'COVN_bcdefgh']
    });
    await expect(mw({
      operation: 'add',
      type: 'coverEdge',
      args: [{ from_id: 'COVN_abcdefg', to_id: 'COVN_bcdefgh' }],
      opts: {},
      result: null
    }, async () => {})).rejects.toMatchObject({ code: 'EDGE_PAIR_NOT_UNIQUE' });
  });

  test('storage adapter identity, snapshot version, and prefix helpers cover edge states', async () => {
    const store = await createStore({
      logger: false,
      config: { dataDir: `${BASE}-identity-store`, maxMemoryMB: 16 }
    });
    try {
      store.registerCollectionIdentity('alpha', 'ALHA');
      expect(() => store.registerCollectionIdentity('alpha', 'DIFF', { recovery: true }))
        .toThrow(/collection identity|ambiguous/i);
      expect(() => store.registerCollectionIdentity('alpha', 'DIFF'))
        .toThrow(/storage identity collision/i);
      expect(() => store.assertCollectionIdentity('alpha', 'DIFF'))
        .toThrow(/storage identity collision/i);
      store.registerCollectionIdentity('bravo', 'BRVO');
      expect(() => store.registerCollectionIdentity('bravissimo', 'BRVO'))
        .toThrow(/storage identity collision/i);
      expect(() => store.assertCollectionIdentity('alpineHa', 'ALHA'))
        .toThrow(/storage identity collision/i);
      await store.removeCollectionIdentity('missing', 'MISS');
      store.loadCollectionIdentityState(null);
      store.loadCollectionIdentityState();
      store.hotTier.documents.set('__bri:collectionIdentity:legacy', {
        data: JSS.stringify({ collection: 'legacy', prefix: 'LEGC' }),
        cold: false
      });
      store.loadCollectionIdentityDocumentsFromHot();
      store.hotTier.sAdd('SKIP?', 'missing');
      store.hotTier.sAdd('SKIP?', 'cold');
      store.hotTier.sAdd('SKIP?', 'bad');
      store.hotTier.documents.set('SKIP_cold', { cold: true });
      store.hotTier.documents.set('SKIP_bad', { data: 'not-jss', cold: false });
      expect(store.iterateHotDocsByPrefix('SKIP')).toEqual([]);
      store.hotTier.sAdd('ASYK?', 'object');
      store.hotTier.sAdd('ASYK?', 'bad');
      store.hotTier.documents.set('ASYK_object', { data: { not: 'string' }, cold: false });
      store.hotTier.documents.set('ASYK_bad', { data: 'not-jss', cold: false });
      await expect(store.getDocsByPrefix('ASYK')).resolves.toEqual([]);
      store.hotTier = null;
      expect(store.loadCollectionIdentityDocumentsFromHot()).toBeUndefined();
      expect(store.iterateHotDocsByPrefix('NONE')).toEqual([]);
      await expect(store.getDocsByPrefix('NONE')).resolves.toEqual([]);
      expect(chooseSnapshotVersion({
        hasIdentityState: true,
        hasV4Payload: false,
        hasV3Payload: false
      })).toBe(5);
      expect(chooseSnapshotVersion({
        hasIdentityState: false,
        hasV4Payload: true,
        hasV3Payload: false
      })).toBe(4);
      expect(collectionIdentitySnapshotState(undefined)).toEqual({
        state: {},
        hasIdentityState: false
      });
    } finally {
      await store.disconnect().catch(() => {});
    }
  });

  test('v4 snapshot recovery buffers graph WAL set and delete deltas', async () => {
    const dir = `${BASE}-v4-graph-recovery`;
    await fs.mkdir(path.join(dir, 'wal'), { recursive: true });
    const edgePrefix = type2Short('coverEdge');
    const edgeId = `${edgePrefix}_abcdefg`;
    const graphState = {
      specs: {
        coverEdge: {
          from: 'from_id',
          to: 'to_id',
          predicate: null,
          predicates: '*',
          symmetric: false
        }
      },
      outgoing: {},
      incoming: {}
    };
    await fs.writeFile(path.join(dir, 'snapshot.jss'), JSS.stringify({
      version: 4,
      walLine: 0,
      timestamp: new Date(),
      documents: {},
      collections: {},
      vectorIndices: {},
      vectorSchemas: {},
      secondaryIndexes: null,
      graphIndices: graphState
    }));
    const writer = new WALWriter(path.join(dir, 'wal'), { logger: false });
    await writer.init();
    await writer.append(createSetEntry(edgeId, JSS.stringify({
      $ID: edgeId,
      from_id: 'COVN_abcdefg',
      to_id: 'COVN_bcdefgh'
    })));
    await writer.append(createDeleteEntry(edgeId));
    await writer.close();

    const store = await createStore({
      logger: false,
      config: { dataDir: dir, maxMemoryMB: 32, logger: false }
    });
    expect(store.getPendingGraphState()).toEqual(graphState);
    expect(store._deferredGraphOps).toEqual([
      expect.objectContaining({ op: 'insert', collection: 'coverEdge' }),
      expect.objectContaining({ op: 'remove', collection: 'coverEdge' })
    ]);
    store._deferredGraphOps.push({ op: 'unknown', collection: 'coverEdge', doc: {} });
    const graph = new GraphIndex();
    store.bindGraphIndex(graph);
    expect(store._deferredGraphOps).toBeNull();
    await store.disconnect();
  });

  test('legacy snapshot recovery fallbacks accept missing optional state payloads', async () => {
    for (const version of [3, 4, 5]) {
      const dir = `${BASE}-snapshot-fallback-${version}`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'snapshot.jss'), JSS.stringify({
        version,
        walLine: 0,
        timestamp: new Date(),
        documents: null,
        collections: null,
        vectorIndices: null,
        vectorSchemas: null,
        secondaryIndexes: null,
        graphIndices: null,
        collectionIdentities: null
      }));
      const store = await createStore({
        logger: false,
        config: { dataDir: dir, maxMemoryMB: 16, logger: false }
      });
      await store.disconnect();
    }
  });

  test('vector topology and WAL close paths cover exported resilience defaults', async () => {
    const index = {
      _levels: new Int32Array(0),
      _neighbors: [],
      _entryPoint: 0,
      _entryLevel: 0,
      _idAt: []
    };
    rebuildTopology(index);
    expect(index._entryPoint).toBe(-1);

    const writer = new WALWriter(path.join(`${BASE}-wal-ebadf`, 'wal'), {
      fsyncMode: 'manual',
      logger: false
    });
    writer.fileHandle = {
      sync: async () => {},
      close: async () => {
        const err = new Error('already closed');
        err.code = 'EBADF';
        throw err;
      }
    };
    await expect(writer.close()).resolves.toBeUndefined();

    const syncFail = new WALWriter(path.join(`${BASE}-wal-sync-fail`, 'wal'), { logger: false });
    syncFail.fileHandle = {
      sync: async () => {
        const err = new Error('sync failed');
        err.code = 'EIO';
        throw err;
      },
      close: async () => {}
    };
    await expect(syncFail.close()).rejects.toThrow(/sync failed/);

    const closeFail = new WALWriter(path.join(`${BASE}-wal-close-fail`, 'wal'), { logger: false });
    closeFail.fileHandle = {
      sync: async () => {},
      close: async () => {
        const err = new Error('close failed');
        err.code = 'EIO';
        throw err;
      }
    };
    await expect(closeFail.close()).rejects.toThrow(/close failed/);

    const timerEvents = [];
    const timerWriter = new WALWriter(path.join(`${BASE}-wal-timer-fail`, 'wal'), {
      fsyncMode: 'manual',
      fsyncIntervalMs: 5,
      logger: { error: (event) => timerEvents.push(event) }
    });
    timerWriter.fileHandle = {
      sync: async () => {
        const err = new Error('timer sync failed');
        err.code = 'EIO';
        throw err;
      }
    };
    timerWriter.startFsyncTimer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(timerWriter.fsyncTimer);
    timerWriter.fsyncTimer = null;
    expect(timerEvents).toContainEqual(expect.objectContaining({
      event: 'storage.wal.fsync.error'
    }));

    const ebadfTimerEvents = [];
    const ebadfTimerWriter = new WALWriter(path.join(`${BASE}-wal-timer-ebadf`, 'wal'), {
      fsyncMode: 'manual',
      fsyncIntervalMs: 5,
      logger: { error: (event) => ebadfTimerEvents.push(event) }
    });
    ebadfTimerWriter.fileHandle = {
      sync: async () => {
        const err = new Error('timer closed');
        err.code = 'EBADF';
        throw err;
      }
    };
    ebadfTimerWriter.startFsyncTimer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(ebadfTimerWriter.fsyncTimer);
    ebadfTimerWriter.fsyncTimer = null;
    expect(ebadfTimerEvents).toEqual([]);
  });
});
