/**
 * @file Child process for tests/e2e/recovery.test.js — kill -9 simulation.
 *
 * Lives as its own file so Node ESM can resolve `from '../../client'`
 * relative paths the same way the Jest runner does. The parent passes
 * the data dir as ARGV[2] so each test run uses an isolated directory.
 */

import { openLocalDatabase } from '../../client/ready-connection.js';

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write('recovery-child: missing dataDir argv\n');
  process.exit(2);
}

const db = await openLocalDatabase({ storeConfig: { dataDir, maxMemoryMB: 64 } });
db.schema('memArt', {
  type:      { type: String, required: true },
  content:   { type: String, required: false },
  embedding: { type: 'vector', dims: 4 }
});

const v = (s) => [
  Math.sin(s) / 2 + 0.5,
  Math.cos(s) / 2 + 0.5,
  Math.sin(s * 2) / 2 + 0.5,
  Math.cos(s * 2) / 2 + 0.5
];

// Committed baseline: 5 docs, no transaction.
for (let i = 0; i < 5; i++) {
  await db.add.memArt({
    type: 'fact', content: 'committed-' + i, embedding: v(i + 1)
  });
}
// Force a snapshot so recovery has both snapshot + WAL to replay.
if (typeof db.snapshot === 'function') await db.snapshot();

// Open a transaction and stage 3 more docs.
db.rec();
for (let i = 0; i < 3; i++) {
  await db.add.memArt({
    type: 'fact', content: 'staged-' + i, embedding: v(100 + i)
  });
}
process.stdout.write('READY\n');

// Hang forever — parent will SIGKILL.
await new Promise(() => {});
