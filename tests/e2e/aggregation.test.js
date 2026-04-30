/**
 * @file UC-X3 acceptance tests — aggregation primitives
 *
 * Acceptance criteria (spec §4 UC-X3):
 *   - count_with_filter
 *   - count_distinct
 *   - group_by_count
 *   - group_by_sum
 *   - group_by_having
 *
 * Plus filter-operator coverage for $gte/$gt/$lte/$lt/$ne/$in/$exists, since
 * UC-X3's having clause requires operators and we want the same operator
 * semantics in .where for symmetry.
 *
 * @implements UC-X3
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import fs from 'fs/promises';

const DIR = './test-data-agg';

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('UC-X3: aggregation', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('.count() returns matching doc count', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true }
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'preference' });

    const allCount = await db.get.memoryArtifactS.count();
    expect(allCount).toBe(3);

    const factCount = await db.get.memoryArtifactS.where({ type: 'fact' }).count();
    expect(factCount).toBe(2);
  });

  test('.distinct(field) returns unique field values', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:    { type: String, required: true },
      session: { type: String, required: false }
    });
    await db.add.memoryArtifact({ type: 'fact', session: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', session: 'S2' });
    await db.add.memoryArtifact({ type: 'fact', session: 'S1' });
    await db.add.memoryArtifact({ type: 'preference', session: 'S3' });

    const sessions = await db.get.memoryArtifactS.distinct('session');
    expect(sessions.sort()).toEqual(['S1', 'S2', 'S3']);

    const factSessions = await db.get.memoryArtifactS
      .where({ type: 'fact' })
      .distinct('session');
    expect(factSessions.sort()).toEqual(['S1', 'S2']);
  });

  test('.groupBy(field).count() returns per-group counts', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true }
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'preference' });
    await db.add.memoryArtifact({ type: 'preference' });

    const groups = await db.get.memoryArtifactS.groupBy('type').count();
    const byType = Object.fromEntries(groups.map(g => [g.type, g.count]));
    expect(byType).toEqual({ fact: 3, preference: 2 });
  });

  test('.groupBy(field).sum(field) returns per-group sums', async () => {
    db = await freshDB();
    db.schema('lexicalEdge', {
      node_a: { type: String, required: true },
      count:  { type: Number, required: true }
    });
    await db.add.lexicalEdge({ node_a: 'A', count: 3 });
    await db.add.lexicalEdge({ node_a: 'A', count: 5 });
    await db.add.lexicalEdge({ node_a: 'B', count: 2 });

    const sums = await db.get.lexicalEdgeS.groupBy('node_a').sum('count');
    const byNode = Object.fromEntries(sums.map(g => [g.node_a, g.sum]));
    expect(byNode).toEqual({ A: 8, B: 2 });
  });

  test('.groupBy(field).sum(field).having(filter) filters groups', async () => {
    db = await freshDB();
    db.schema('lexicalEdge', {
      node_a: { type: String, required: true },
      count:  { type: Number, required: true }
    });
    await db.add.lexicalEdge({ node_a: 'A', count: 7 });
    await db.add.lexicalEdge({ node_a: 'A', count: 5 });   // sum=12
    await db.add.lexicalEdge({ node_a: 'B', count: 3 });   // sum=3
    await db.add.lexicalEdge({ node_a: 'C', count: 10 });  // sum=10

    const popular = await db.get.lexicalEdgeS
      .groupBy('node_a')
      .sum('count')
      .having({ sum: { $gte: 10 } });

    const ids = popular.map(g => g.node_a).sort();
    expect(ids).toEqual(['A', 'C']);
  });

  test('groupBy.count.having filters groups by group count', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true }
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'preference' });

    const popular = await db.get.memoryArtifactS
      .groupBy('type')
      .count()
      .having({ count: { $gte: 2 } });

    expect(popular).toHaveLength(1);
    expect(popular[0].type).toBe('fact');
    expect(popular[0].count).toBe(2);
  });

  test('filter operators: $gte / $lte / $gt / $lt', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      score: { type: Number, required: true }
    });
    for (const score of [1, 5, 10, 15, 20]) {
      await db.add.memoryArtifact({ score });
    }

    const gte10 = await db.get.memoryArtifactS.where({ score: { $gte: 10 } });
    expect(gte10.map(d => d.score).sort((a, b) => a - b)).toEqual([10, 15, 20]);

    const lt10 = await db.get.memoryArtifactS.where({ score: { $lt: 10 } });
    expect(lt10.map(d => d.score).sort((a, b) => a - b)).toEqual([1, 5]);

    const between = await db.get.memoryArtifactS.where({ score: { $gt: 5, $lte: 15 } });
    expect(between.map(d => d.score).sort((a, b) => a - b)).toEqual([10, 15]);
  });

  test('filter operators: $ne / $in / $exists', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:    { type: String, required: true },
      tag:     { type: String, required: false }
    });
    await db.add.memoryArtifact({ type: 'fact', tag: 'red' });
    await db.add.memoryArtifact({ type: 'fact', tag: 'blue' });
    await db.add.memoryArtifact({ type: 'fact' });
    await db.add.memoryArtifact({ type: 'preference', tag: 'green' });

    const notFact = await db.get.memoryArtifactS.where({ type: { $ne: 'fact' } });
    expect(notFact).toHaveLength(1);

    const someTags = await db.get.memoryArtifactS.where({ tag: { $in: ['red', 'green'] } });
    expect(someTags.map(d => d.tag).sort()).toEqual(['green', 'red']);

    const tagged = await db.get.memoryArtifactS.where({ tag: { $exists: true } });
    expect(tagged).toHaveLength(3);

    const untagged = await db.get.memoryArtifactS.where({ tag: { $exists: false } });
    expect(untagged).toHaveLength(1);
  });

  test('filter operators: $in requires an array (compileFilter guard)', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      tag: { type: String, required: false }
    });
    await db.add.memoryArtifact({ tag: 'x' });
    await expect(
      db.get.memoryArtifactS.where({ tag: { $in: 'not-array' } }).toArray()
    ).rejects.toThrow(/\$in expects an array/);
  });

  test('filter operators: unknown operator throws', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      tag: { type: String, required: false }
    });
    await db.add.memoryArtifact({ tag: 'x' });
    await expect(
      db.get.memoryArtifactS.where({ tag: { $bogus: 1 } }).toArray()
    ).rejects.toThrow(/Unsupported filter operator/);
  });

  test('groupBy.having rejects non-object filter (shared compileFilter guard)', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type: { type: String, required: true }
    });
    await db.add.memoryArtifact({ type: 'fact' });
    await expect(
      db.get.memoryArtifactS.groupBy('type').count().having(7).toArray()
    ).rejects.toThrow(/compileFilter: unsupported filter type number/);
  });

  test('count of distinct + groupBy compose with .where', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:         { type: String, required: true },
      usage_count:  { type: Number, required: false },
      session:      { type: String, required: false }
    });
    await db.add.memoryArtifact({ type: 'fact', usage_count: 1, session: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', usage_count: 5, session: 'S1' });
    await db.add.memoryArtifact({ type: 'fact', usage_count: 7, session: 'S2' });
    await db.add.memoryArtifact({ type: 'preference', usage_count: 3, session: 'S2' });

    const sessions = await db.get.memoryArtifactS
      .where({ type: 'fact', usage_count: { $gte: 3 } })
      .distinct('session');
    expect(sessions.sort()).toEqual(['S1', 'S2']);
  });
});
