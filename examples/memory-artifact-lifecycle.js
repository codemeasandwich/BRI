#!/usr/bin/env node
/**
 * @file Runnable example for spec §F Test 1 — memory artifact lifecycle.
 *
 * Demonstrates end-to-end the memory-tier flow Ashlyn programs against:
 *   - declare a schema with a vector field, supersession, confidence, cascade
 *   - insert several memory artifacts
 *   - recall via .where + .near
 *   - filter by .confidence threshold
 *   - supersede an old fact and verify default reads hide it
 *   - cancel the session and verify cascade deletes
 *
 * Usage:
 *   node examples/memory-artifact-lifecycle.js
 *
 * The example runs against a temporary data dir so it leaves no state
 * behind. Output is plain text suitable for piping into a doc renderer.
 */

import { openLocalDatabase } from '../src/client/ready-connection.js';
import { applyFixtureSchemas } from '../tests/fixtures/schemas.js';
import { makeEmbedding, nearVectorOf } from '../tests/fixtures/embeddings.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const DIMS = 8;
const tmpDir = path.join(os.tmpdir(), 'bri-example-memartifact-' + Date.now());

const db = await openLocalDatabase({ storeConfig: { dataDir: tmpDir, maxMemoryMB: 64 } });
applyFixtureSchemas(db, { dims: DIMS });

console.log('--- Step 1: insert two facts in session S1 ---');
const a = await db.add.memoryArtifact({
  type: 'fact', content: 'cats sleep 16h/day',
  embedding: makeEmbedding(1, DIMS),
  confidence: 0.6,
  source_session_id: 'S1'
});
const b = await db.add.memoryArtifact({
  type: 'fact', content: 'dogs sleep 12h/day',
  embedding: makeEmbedding(2, DIMS),
  confidence: 0.85,
  source_session_id: 'S1'
});
console.log('inserted:', a.$ID, b.$ID);

console.log('\n--- Step 2: recall via .where + .near ---');
const hits = await db.get.memoryArtifactS
  .where({ type: 'fact' })
  .near(nearVectorOf(1, DIMS), 5);
for (const h of hits) {
  console.log(`  ${h.$ID}  cosine=${h.$cosine.toFixed(3)}  ${h.content}`);
}

console.log('\n--- Step 3: filter by .confidence(>= 0.8) ---');
const trustworthy = await db.get.memoryArtifactS.confidence(0.8).toArray();
for (const t of trustworthy) {
  console.log(`  ${t.$ID}  conf=${t.confidence}  ${t.content}`);
}

console.log('\n--- Step 4: supersede the older cat fact ---');
const c = await db.add.memoryArtifact({
  type: 'fact', content: 'cats sleep 13-16h/day',
  embedding: makeEmbedding(3, DIMS),
  confidence: 0.95,
  source_session_id: 'S1'
});
a.superseded_by_id = c.$ID;
await a.save();

const visible = await db.get.memoryArtifactS.toArray();
console.log('default reads (superseded hidden):',
            visible.map(v => v.content));

const all = await db.get.memoryArtifactS.history.toArray();
console.log('with .history (sees all):', all.map(v => v.content));

console.log('\n--- Step 5: cancel session S1 ---');
const result = await db.cascade.session('S1');
console.log('cascade result:', result);

const remaining = await db.get.memoryArtifactS.history.toArray();
console.log('remaining after cascade:', remaining.length);

await db.disconnect();
await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
console.log('\ndone — temporary data dir cleaned up.');
