/**
 * @file Stable **`tests/helpers`** barrel that re-exports READY helpers from **`src/client/ready-connection.js`**.
 *
 * Keeps every E2E suite aligned with Docker/server bootstrap (`openLocalDatabase` /
 * `openRemoteDatabase`) without importing deep paths individually.
 */

export {
  normalizedWsUrl,
  openLocalDatabase,
  openRemoteDatabase
} from '../../src/client/ready-connection.js';
