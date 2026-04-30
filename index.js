/**
 * @file BRI — Bigdata Repository of Intelligence
 *
 * Default export `bri` is the sole supported entry (`bri.connect`). No legacy wrappers.
 */

export { default, bri, deferDatabase } from './client/index.js';
export {
  normalizedWsUrl,
  openLocalDatabase,
  openRemoteDatabase
} from './client/ready-connection.js';
export { createRemoteDatabasePromise } from './remote/index.js';
export { createLocalDatabasePromise } from './client/create-local-db.js';
