#!/usr/bin/env node
/**
 * @file Runnable example for spec §F Test 2 — knowledge graph triples.
 *
 * Demonstrates end-to-end the knowledge-tier flow:
 *   - declare entity + edge schemas with predicates and supersession
 *   - load 8 entities and 12 triples from the shared fixture
 *   - read targets via the predicate proxy
 *   - filter by confidence
 *   - supersede a triple and walk the chain
 *   - parameterized expansion (multi-hop)
 *
 * Usage:
 *   node examples/knowledge-graph-triples.js
 *
 * Runs against a temporary data dir; cleans up on exit.
 */

import { openLocalDatabase } from '../client/ready-connection.js';
import { applyFixtureSchemas } from '../tests/fixtures/schemas.js';
import { loadKGFixture } from '../tests/fixtures/triples.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const tmpDir = path.join(os.tmpdir(), 'bri-example-kg-' + Date.now());
const db = await openLocalDatabase({ storeConfig: { dataDir: tmpDir, maxMemoryMB: 64 } });
applyFixtureSchemas(db, { dims: 8 });

console.log('--- Step 1: load fixture (8 entities, 12 triples) ---');
const { entities, idsByName } = await loadKGFixture(db);
const byName = Object.fromEntries(entities.map(e => [e.name, e]));
console.log(`loaded entities: ${entities.map(e => e.name).join(', ')}`);

console.log('\n--- Step 2: predicate proxy reads ---');
const employers = await byName['Alice'].works_at;
console.log("Alice's employers:", employers.map(e => e.name));
const employees = await byName['Acme'].inverse.works_at;
console.log("Acme's employees:", employees.map(e => e.name));

console.log('\n--- Step 3: filter by .confidence(>= 0.75) ---');
const trustyAcquaintances = await byName['Alice'].knows.confidence(0.75);
console.log("Alice's high-confidence knows:",
            trustyAcquaintances.map(t => t.name));

console.log('\n--- Step 4: supersede a triple, walk the chain ---');
const aliceId = idsByName['Alice'];
const oldKnows = (await db.get.kgTripleS({
  subject_id: aliceId, predicate: 'knows',
  object_id_or_literal: idsByName['Carol']
}))[0];
const newKnows = await db.add.kgTriple({
  subject_id: aliceId, predicate: 'knows',
  object_id_or_literal: idsByName['Carol'],
  confidence: 0.9, source_session_id: 'fixture',
  provenance_turn_ids: ['turn-2']
});
oldKnows.superseded_by_id = newKnows.$ID;
await oldKnows.save();
newKnows.supersedes_id = oldKnows.$ID;
await newKnows.save();

const chain = await newKnows.chain.supersedes_id;
console.log(`chain length: ${chain.length}`);
console.log(`chain: ${chain.map(t => t.$ID).join(' → ')}`);

console.log('\n--- Step 5: 1-hop expand from Alice ---');
const fan = await byName['Alice'].expand({ via: 'kgTriple', hops: 1 });
console.log('reached nodes:', fan.nodes.map(n => n.name));
console.log('edge count:', fan.edges.length);

await db.disconnect();
await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
console.log('\ndone — temporary data dir cleaned up.');
