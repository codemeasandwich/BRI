/**
 * Child for tests/e2e/vector.test.js — exits without disconnect() so no final
 * snapshot runs; a mid-run checkpoint + WAL tail must survive recover() and
 * route doc SETs through applyVectorWrite and WAL DELETE lines through
 * applyVectorDelete (hardDelete emits DELETE; soft db.del uses rename only).
 */
import { createDB } from '../../client/index.js';

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write('vector-wal-recovery-child: missing dataDir argv\n');
  process.exit(2);
}

const db = await createDB({
  storeConfig: {
    dataDir,
    maxMemoryMB: 64,
    fsyncMode: 'always'
  }
});

db.schema('vecWalChunk', {
  tag: { type: String, required: true },
  embedding: { type: 'vector', dims: 4, required: false }
});

const embPre = [1, 0, 0, 0];
const embPost = [0, 1, 0, 0];

const dPre = await db.add.vecWalChunk({ tag: 'pre', embedding: embPre });

await db._store.createSnapshot();

await db._store.hardDelete(dPre.$ID);

await db.add.vecWalChunk({ tag: 'post', embedding: embPost });

process.stdout.write('READY\n');
// Short delay so stdout flushes; fsyncMode 'always' keeps WAL durable without disconnect.
setTimeout(() => process.exit(0), 50);
