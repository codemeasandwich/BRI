/**
 * BRI Client - Public database interface
 *
 * Main entry point for creating and accessing BRI databases.
 */

import { createStore } from '../storage/index.js';
import { createEngine } from '../engine/index.js';
import { createDBInterface } from './proxy.js';

/**
 * Create BRI Database instance
 * @param {Object} options
 * @param {'inhouse'} options.storeType - Storage backend type
 * @param {Object} options.storeConfig - Storage configuration
 * @returns {Promise<Object>} - Database interface
 */
async function createDB(options = {}) {
  // Initialize storage adapter
  const store = await createStore({
    type: options.storeType || 'inhouse',
    config: options.storeConfig || {
      dataDir: process.env.BRI_DATA_DIR || './data',
      maxMemoryMB: parseInt(process.env.BRI_MAX_MEMORY_MB) || 256
    }
  });

  console.log('BRI: Connected to storage');

  // Create engine with all CRUD operations
  const engine = createEngine(store);

  // Create public interface with proxy handlers
  const db = createDBInterface(engine, store);

  return db;
}

// Singleton pattern for default instance
let defaultDB = null;

/**
 * Get or create default database instance
 * @param {Object} options - Options for createDB if creating new instance
 * @returns {Promise<Object>} - Database interface
 */
export async function getDB(options) {
  if (!defaultDB) {
    defaultDB = await createDB(options);
  }
  return defaultDB;
}

export { createDB };
export default createDB;
