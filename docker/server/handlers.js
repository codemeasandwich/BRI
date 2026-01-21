/**
 * @file RPC request handlers for BRI database operations
 */

import { getState, toPlainObject } from './utils.js';
import { handleGet, handleAdd, handleSet, handleDel } from './crud.js';

/**
 * Handle RPC calls from WebSocket clients
 * @param {Object} db - BRI database instance
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} type - RPC type (e.g., "db/get/user")
 * @param {Object} payload - RPC payload
 * @returns {Promise<*>} Operation result
 */
export async function handleRPC(db, ws, type, payload) {
  const state = getState(ws);
  const opts = state.activeTxnId ? { txnId: state.activeTxnId } : {};
  const parts = type.split('/');

  if (parts[0] !== 'db') {
    throw new Error(`Unknown RPC namespace: ${parts[0]}`);
  }

  const operation = parts[1];
  const collection = parts[2];

  switch (operation) {
    case 'get':
      return handleGet(db, state, collection, payload, opts);
    case 'add':
      return handleAdd(db, state, collection, payload, opts);
    case 'set':
      return handleSet(db, state, collection, payload, opts);
    case 'del':
      return handleDel(db, state, collection, payload, opts);
    case 'sub':
      return handleSub(db, ws, state, collection, payload);
    case 'unsub':
      return handleUnsub(state, collection);
    case 'populate':
      return handlePopulate(state, payload);
    case 'save':
      return handleSave(state, payload, opts);
    case 'txn':
      return handleTxn(db, state, parts[2]);
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

/**
 * Handle SUB operations (subscriptions)
 * @param {Object} db - Database instance
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} state - Connection state
 * @param {string} collection - Collection name
 * @param {Object} payload - Request payload
 * @returns {Promise<Object>} Subscription confirmation
 */
async function handleSub(db, ws, state, collection, payload) {
  const { type: subType } = payload;
  if (state.subscriptions.has(subType)) {
    state.subscriptions.get(subType)();
  }
  const unsubscribe = await db.sub[collection]((change) => {
    ws.send(JSON.stringify({ type: `db:sub:${collection}`, data: toPlainObject(change) }));
  });
  state.subscriptions.set(collection, unsubscribe);
  return { subscribed: true, type: collection };
}

/**
 * Handle UNSUB operations (unsubscriptions)
 * @param {Object} state - Connection state
 * @param {string} collection - Collection name
 * @returns {Object} Unsubscription confirmation
 */
function handleUnsub(state, collection) {
  if (state.subscriptions.has(collection)) {
    state.subscriptions.get(collection)();
    state.subscriptions.delete(collection);
  }
  return { unsubscribed: true, type: collection };
}

/**
 * Handle POPULATE operations
 * @param {Object} state - Connection state
 * @param {Object} payload - Request payload
 * @returns {Promise<Object>} Populated entity
 */
async function handlePopulate(state, payload) {
  const { entityId, field } = payload;
  const entity = state.entities.get(entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }
  const populated = await entity.and[field];
  state.entities.set(entityId, populated);
  if (populated[field] && populated[field].$ID) {
    state.entities.set(populated[field].$ID, populated[field]);
  }
  return toPlainObject(populated);
}

/**
 * Handle SAVE operations
 * @param {Object} state - Connection state
 * @param {Object} payload - Request payload
 * @param {Object} opts - Operation options
 * @returns {Promise<Object>} Saved entity
 */
async function handleSave(state, payload, opts) {
  const { entityId, changes } = payload;
  const entity = state.entities.get(entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }
  for (const [key, value] of Object.entries(changes)) {
    entity[key] = value;
  }
  const saved = await entity.save(opts);
  state.entities.set(saved.$ID, saved);
  return toPlainObject(saved);
}

/**
 * Handle TXN operations (transactions)
 * @param {Object} db - Database instance
 * @param {Object} state - Connection state
 * @param {string} txnOp - Transaction operation type
 * @returns {Promise<*>} Transaction result
 */
async function handleTxn(db, state, txnOp) {
  switch (txnOp) {
    case 'rec': {
      const txnId = db.rec();
      state.activeTxnId = txnId;
      return { txnId };
    }
    case 'fin': {
      const result = await db.fin();
      state.activeTxnId = null;
      return result;
    }
    case 'nop': {
      const result = await db.nop();
      state.activeTxnId = null;
      return result;
    }
    case 'pop':
      return await db.pop();
    case 'status':
      return db.txnStatus();
    default:
      throw new Error(`Unknown transaction operation: ${txnOp}`);
  }
}
