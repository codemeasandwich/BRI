/**
 * @file Spec §8 #8 — kill -9 mid-transaction recovery.
 *
 * Definition of Done #8: "the recovery test passes a `kill -9`
 * mid-transaction simulated crash and restart, verifying index state is
 * pre-transaction-clean."
 *
 * The test spawns a child Node process that:
 *   1. Opens a fresh data dir + db
 *   2. Inserts 5 docs OUTSIDE any txn (committed baseline)
 *   3. Opens a transaction
 *   4. Stages 3 more vector docs INSIDE the txn
 *   5. Logs READY then waits for SIGKILL
 *
 * The parent kills the child (process.kill with SIGKILL == kill -9 on
 * unix), then re-opens the SAME data dir in this process and asserts:
 *   - The 5 committed docs are still searchable (recovery from snapshot
 *     + WAL replay).
 *   - The 3 staged docs are NOT searchable — the deferred-linking
 *     transaction model means staged ops never touched the committed
 *     index, and a SIGKILL leaves no trace.
 *
 * Why a child process: an in-process simulation can't model the OS
 * killing the runtime mid-flight. SIGKILL is the brutal real-world test;
 * a process.exit() would still let async cleanup run.
 *
 * @implements spec §8 #8
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', '..', 'test-data-recovery');

const CHILD_SCRIPT = path.resolve(HERE, 'recovery-child.mjs');

/** Wait for the child to print READY on stdout. */
function waitReady(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('READY')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code, sig) => reject(new Error(
      `child exited before READY (code=${code} sig=${sig})`)));
  });
}

describe('Recovery (spec §8 #8)', () => {
  beforeEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });
  afterAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('kill_-9_mid_transaction_leaves_pre_txn_state', async () => {
    // --experimental-specifier-resolution=node lets Node ESM resolve
    // directory imports (e.g. `import from '../utils/diff'`) the same
    // way Jest's experimental-vm-modules does. Without it, the child
    // crashes on directory imports that the rest of the codebase uses.
    const child = spawn('node',
      ['--experimental-specifier-resolution=node', CHILD_SCRIPT, DIR],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Surface child stderr if anything goes wrong.
    let childStderr = '';
    child.stderr.on('data', d => { childStderr += d.toString(); });

    await waitReady(child);
    // SIGKILL — the child cannot trap, cleanup, or persist.
    child.kill('SIGKILL');
    await new Promise(resolve => child.on('exit', resolve));

    // Re-open the same data dir. Recovery should replay committed state
    // only; staged docs from the killed txn are dropped on the floor.
    const db2 = await openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
    db2.schema('memArt', {
      type:      { type: String, required: true },
      content:   { type: String, required: false },
      embedding: { type: 'vector', dims: 4 }
    });
    try {
      const all = await db2.get.memArtS();
      const contents = all.map(d => d.content).sort();
      // 5 committed should be present; no `staged-` artifacts.
      const committed = contents.filter(c => c && c.startsWith('committed-'));
      const staged = contents.filter(c => c && c.startsWith('staged-'));
      expect(committed.length).toBe(5);
      expect(staged.length).toBe(0);
      if (childStderr.length > 0 && committed.length !== 5) {
        // Surface child stderr if assertion fails — useful for debugging.
        console.error('child stderr:', childStderr);
      }
    } finally {
      await db2.disconnect();
    }
  }, 30_000);
});
