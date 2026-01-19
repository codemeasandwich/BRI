/**
 * @file BRI - Bigdata Repository of Intelligence
 *
 * Main entry point - re-exports from client and remote modules.
 */

export { createDB, getDB, default } from './client/index.js';
export { apiDB, createRemoteDB } from './remote/index.js';
