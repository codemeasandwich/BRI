/**
 * @file UC-X4 (FTS substring) + UC-V3 (combined alias/vector) acceptance.
 *
 * Acceptance criteria:
 *   UC-X4
 *     - substring_match_returns_top_k
 *     - recency_tiebreak (equal-match ties broken by updatedAt desc)
 *     - fts_index_eventually_consistent (v1 has no index — always consistent)
 *   UC-V3
 *     - combined_alias_and_embedding (weighted blend of .match + .near)
 *     - null_embedding_eligible_via_alias (docs with no embedding still rank
 *       via alias match alone)
 *     - audit_trail_components_returned ($cosine + $matchHits + $score on
 *       each result so callers can inspect the blend)
 *
 * These tests gate the v1 substring-FTS surface and its composition with
 * vector search. v2 will add stemming / stopwords / persistent FTS index;
 * v1 is correctness-only on inline scan.
 *
 * @implements UC-X4, UC-V3
 */
import { jest } from '@jest/globals';
import { createDB } from '../../client/index.js';
import fs from 'fs/promises';

const DIR = './test-data-match';
const DIMS = 4;

/**
 * Deterministic synthetic embedding (same shape as vector.test.js).
 * @param {string} seed
 * @returns {Array<number>}
 */
function makeVec(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const v = new Array(DIMS);
  let mag = 0;
  for (let i = 0; i < DIMS; i++) {
    h = (h * 1103515245 + 12345) | 0;
    v[i] = ((h >>> 0) % 1000) / 1000 - 0.5;
    mag += v[i] * v[i];
  }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= mag;
  return v;
}

async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return createDB({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('UC-X4: .match substring FTS', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('.match returns docs whose string field contains the query', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      content: { type: String, required: true }
    });
    await db.add.memoryArtifact({ content: 'API gateway design notes' });
    await db.add.memoryArtifact({ content: 'unrelated content' });
    await db.add.memoryArtifact({ content: 'Notes on the API gateway tier' });

    const hits = await db.get.memoryArtifactS.match({ content: 'API gateway' });
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.content.toLowerCase()).toContain('api gateway');
    }
  });

  test('.match is case-insensitive', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', { content: { type: String, required: true } });
    await db.add.memoryArtifact({ content: 'API GATEWAY' });
    await db.add.memoryArtifact({ content: 'api gateway' });
    await db.add.memoryArtifact({ content: 'unrelated' });

    const hits = await db.get.memoryArtifactS.match({ content: 'api Gateway' });
    expect(hits).toHaveLength(2);
  });

  test('.match works on Array fields (any item containing the substring)', async () => {
    db = await freshDB();
    db.schema('kgEntity', {
      name:    { type: String, required: true },
      aliases: { type: Array,  required: false, items: String }
    });
    await db.add.kgEntity({ name: 'gateway', aliases: ['API gateway', 'router'] });
    await db.add.kgEntity({ name: 'unrelated', aliases: ['something else'] });
    await db.add.kgEntity({ name: 'no-aliases' });

    const hits = await db.get.kgEntityS.match({ aliases: 'API gateway' });
    expect(hits.map(h => h.name)).toEqual(['gateway']);
  });

  test('.match attaches $matchHits metadata describing where the match landed', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', { content: { type: String, required: true } });
    await db.add.memoryArtifact({ content: 'API gateway design' });

    const [hit] = await db.get.memoryArtifactS.match({ content: 'gateway' });
    expect(hit.$matchHits).toBeDefined();
    expect(hit.$matchHits.field).toBe('content');
    expect(hit.$matchHits.value).toBe('gateway');
  });

  test('.match top-k bound caps the result', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', { content: { type: String, required: true } });
    for (let i = 0; i < 10; i++) {
      await db.add.memoryArtifact({ content: `API gateway match ${i}` });
    }
    const hits = await db.get.memoryArtifactS.match({ content: 'API gateway' }, 3);
    expect(hits).toHaveLength(3);
  });

  test('recency tiebreak — newer docs rank above older on equal match', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', { content: { type: String, required: true } });
    const older = await db.add.memoryArtifact({ content: 'gateway' });
    // Force a measurable updatedAt gap.
    await new Promise(r => setTimeout(r, 5));
    const newer = await db.add.memoryArtifact({ content: 'gateway' });

    const hits = await db.get.memoryArtifactS.match({ content: 'gateway' });
    expect(hits.map(h => h.$ID)).toEqual([newer.$ID, older.$ID]);
  });

  test('.match composes with .where', async () => {
    db = await freshDB();
    db.schema('memoryArtifact', {
      type:    { type: String, required: true },
      content: { type: String, required: true }
    });
    await db.add.memoryArtifact({ type: 'fact', content: 'API gateway notes' });
    await db.add.memoryArtifact({ type: 'preference', content: 'API gateway notes' });

    const factsOnly = await db.get.memoryArtifactS
      .where({ type: 'fact' })
      .match({ content: 'API gateway' });
    expect(factsOnly).toHaveLength(1);
    expect(factsOnly[0].type).toBe('fact');
  });
});

describe('UC-V3: combined alias + embedding via .combine', () => {
  let db;
  afterEach(async () => {
    if (db) await db.disconnect();
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('.combine blends .match and .near scores by declared weights', async () => {
    db = await freshDB();
    db.schema('kgEntity', {
      name:      { type: String, required: true },
      aliases:   { type: Array,  required: false, items: String },
      embedding: { type: 'vector', dims: DIMS, required: false }
    });
    const queryVec = makeVec('q');

    // Doc A: strong embedding, no alias match
    const a = await db.add.kgEntity({
      name: 'A', aliases: ['something else'], embedding: queryVec
    });
    // Doc B: alias match, weak embedding
    const b = await db.add.kgEntity({
      name: 'B', aliases: ['API gateway'], embedding: makeVec('far')
    });
    // Doc C: no match, no relevant embedding
    await db.add.kgEntity({
      name: 'C', aliases: ['unrelated'], embedding: makeVec('also-far')
    });

    const results = await db.get.kgEntityS
      .match({ aliases: 'API gateway' })
      .near(queryVec, 5)
      .combine({ alias: 0.4, vector: 0.6 });

    // Both A and B should appear with $score reflecting the blend.
    const ids = results.map(r => r.$ID);
    expect(ids).toContain(a.$ID);
    expect(ids).toContain(b.$ID);
    // Each has a $score, $cosine (from .near), and $matchHits (from .match)
    // when the corresponding component contributed.
    for (const r of results) {
      expect(typeof r.$score).toBe('number');
    }
  });

  test('docs with null embedding are eligible via alias-only match', async () => {
    db = await freshDB();
    db.schema('kgEntity', {
      name:      { type: String, required: true },
      aliases:   { type: Array,  required: false, items: String },
      embedding: { type: 'vector', dims: DIMS, required: false }
    });
    const queryVec = makeVec('q');
    // Doc with NO embedding but matching alias
    const aliasOnly = await db.add.kgEntity({
      name: 'AliasOnly', aliases: ['API gateway']
    });
    // Doc with embedding but no alias match
    await db.add.kgEntity({
      name: 'VectorOnly', aliases: ['unrelated'], embedding: queryVec
    });

    const results = await db.get.kgEntityS
      .match({ aliases: 'API gateway' })
      .near(queryVec, 5)
      .combine({ alias: 0.4, vector: 0.6 });

    // AliasOnly must be in the results (eligibility via alias alone).
    expect(results.map(r => r.$ID)).toContain(aliasOnly.$ID);
  });

  test('audit-trail components on each result ($score, $cosine, $matchHits)', async () => {
    db = await freshDB();
    db.schema('kgEntity', {
      name:      { type: String, required: true },
      aliases:   { type: Array,  required: false, items: String },
      embedding: { type: 'vector', dims: DIMS, required: false }
    });
    const queryVec = makeVec('q');
    const a = await db.add.kgEntity({
      name: 'A', aliases: ['API gateway'], embedding: queryVec
    });

    const [hit] = await db.get.kgEntityS
      .match({ aliases: 'API gateway' })
      .near(queryVec, 5)
      .combine({ alias: 0.4, vector: 0.6 });

    expect(hit.$ID).toBe(a.$ID);
    expect(typeof hit.$score).toBe('number');
    expect(typeof hit.$cosine).toBe('number');
    expect(hit.$matchHits).toBeDefined();
    // Audit invariant: $score should be the explicit weighted blend.
    const expectedScore = 0.4 * 1 + 0.6 * hit.$cosine;
    expect(Math.abs(hit.$score - expectedScore)).toBeLessThan(1e-9);
  });
});
