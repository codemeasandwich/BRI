/**
 * @file BRI — Bigdata Repository of Intelligence
 *
 * Default export `bri` is the sole supported entry (`bri.connect`). No legacy wrappers.
 */

export { default, bri, deferDatabase } from './src/client/index.js';
export {
  normalizedWsUrl,
  openLocalDatabase,
  openRemoteDatabase
} from './src/client/ready-connection.js';
export { createRemoteDatabasePromise } from './src/remote/index.js';
export { createLocalDatabasePromise } from './src/client/create-local-db.js';
