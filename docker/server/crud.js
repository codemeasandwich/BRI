/**
 * @file CRUD operation handlers for BRI RPC server
 */

import { toPlainObject } from './utils.js';

/**
 * Handle GET operations
 * @param {Object} db - Database instance
 * @param {Object} state - Connection state
 * @param {string} collection - Collection name
 * @param {Object} payload - Request payload
 * @param {Object} opts - Operation options
 * @returns {Promise<*>} Query result
 */
export async function handleGet(db, state, collection, payload, opts) {
  const { query } = payload;
  const result = await db.get[collection](query, opts);

  if (result && result.$ID) {
    state.entities.set(result.$ID, result);
  } else if (Array.isArray(result)) {
    for (const entity of result) {
      if (entity.$ID) {
        state.entities.set(entity.$ID, entity);
      }
    }
  }

  return toPlainObject(result);
}

/**
 * Handle ADD operations
 * @param {Object} db - Database instance
 * @param {Object} state - Connection state
 * @param {string} collection - Collection name
 * @param {Object} payload - Request payload
 * @param {Object} opts - Operation options
 * @returns {Promise<Object>} Created entity
 */
export async function handleAdd(db, state, collection, payload, opts) {
  const { data, opts: clientOpts = {} } = payload;
  const mergedOpts = { ...clientOpts, ...opts };
  const result = await db.add[collection](data, mergedOpts);

  if (result && result.$ID) {
    state.entities.set(result.$ID, result);
  }

  return toPlainObject(result);
}

/**
 * Handle SET operations
 * @param {Object} db - Database instance
 * @param {Object} state - Connection state
 * @param {string} collection - Collection name
 * @param {Object} payload - Request payload
 * @param {Object} opts - Operation options
 * @returns {Promise<Object>} Updated entity
 */
export async function handleSet(db, state, collection, payload, opts) {
  const { data, opts: clientOpts = {} } = payload;
  const mergedOpts = { ...clientOpts, ...opts };
  const result = await db.set[collection](data, mergedOpts);

  if (result && result.$ID) {
    state.entities.set(result.$ID, result);
  }

  return toPlainObject(result);
}

/**
 * Handle DEL operations
 * @param {Object} db - Database instance
 * @param {Object} state - Connection state
 * @param {string} collection - Collection name
 * @param {Object} payload - Request payload
 * @param {Object} opts - Operation options
 * @returns {Promise<*>} Deletion result
 */
export async function handleDel(db, state, collection, payload, opts) {
  const { id, deletedBy } = payload;
  const result = await db.del[collection](id, deletedBy, opts);
  state.entities.delete(id);
  return result;
}
