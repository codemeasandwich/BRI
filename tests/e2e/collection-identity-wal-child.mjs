/**
 * @file Child process fixture for WAL-only collection identity recovery.
 *
 * The parent test needs a process that writes through the public local database
 * API and exits without `disconnect()`. That leaves WAL records as the only
 * recovery source for both the user row and the identity catalog.
 */

import { openLocalDatabase } from '../helpers/open-database.js';

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write('collection-identity-wal-child: missing dataDir argv\n');
  process.exit(1);
}

const db = await openLocalDatabase({
  logger: false,
  storeConfig: {
    dataDir,
    maxMemoryMB: 64
  }
});

await db.add.alpha({ name: 'wal-alpha' });
process.stdout.write('READY\n');
process.exit(0);
