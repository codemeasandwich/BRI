/**
 * @file BRI Remote — WebSocket façade builder (`createRemoteDatabasePromise`).
 *
 * Applications use `import bri from 'bri-db'; bri.connect({ url })` exclusively.
 */

import { createOperationProxy } from './proxy.js';
import { wrapEntity } from './entity.js';

/**
 * Build the remote database facade after the WebSocket is OPEN and `rpc` is usable.
 *
 * @param {*} socket
 * @param {(type: string, payload: Object) => Promise<any>} rpc
 * @param {(type: string, listener: Function) => void} addEventListener
 * @param {(type: string, listener: Function) => void} removeEventListener
 * @returns {Object} Remote **`db`** façade (CRUD proxies, txn helpers, subscriptions)
 */
function buildRemoteDb(socket, rpc, addEventListener, removeEventListener) {
  let _activeTxnId = null;

  const db = {
    get: createOperationProxy('get', rpc, wrapEntity),
    add: createOperationProxy('add', rpc, wrapEntity),
    set: createOperationProxy('set', rpc, wrapEntity),
    del: createOperationProxy('del', rpc, wrapEntity),

    get _activeTxnId() {
      return _activeTxnId;
    },

    sub: new Proxy({}, {
      /** @param {Object} target @param {string} collection @returns {Function} */
      get(target, collection) {
        return async (callback) => {
          addEventListener(collection, callback);
          await rpc(`db/sub/${collection}`, { type: collection });
          return () => {
            removeEventListener(collection, callback);
            rpc(`db/unsub/${collection}`, { type: collection }).catch(() => {});
          };
        };
      }
    }),

    /** Start a transaction @returns {Promise<string>} Transaction ID */
    rec() {
      return rpc('db/txn/rec', {}).then((r) => {
        _activeTxnId = r.txnId;
        return r.txnId;
      });
    },

    /** Commit transaction @param {string} [txnId] @returns {Promise<Object>} */
    async fin(txnId) {
      const result = await rpc('db/txn/fin', { txnId: txnId || _activeTxnId });
      _activeTxnId = null;
      return result;
    },

    /** Cancel transaction @param {string} [txnId] @returns {Promise<Object>} */
    async nop(txnId) {
      const result = await rpc('db/txn/nop', { txnId: txnId || _activeTxnId });
      _activeTxnId = null;
      return result;
    },

    /** Undo last action @param {string} [txnId] @returns {Promise<Object>} */
    async pop(txnId) {
      return rpc('db/txn/pop', { txnId: txnId || _activeTxnId });
    },

    /** Transaction status RPC for active or explicit txnId. @param {string} [txnId] @returns {Promise<*>} */
    txnStatus(txnId) {
      return rpc('db/txn/status', { txnId: txnId || _activeTxnId });
    },

    /** Close WebSocket */
    async disconnect() {
      if (socket) socket.close();
    },

    _rpc: rpc,
    _connected: () => !!(socket && socket.readyState === 1)
  };

  return db;
}

/**
 * Resolve the remote façade after `/api/ape` reaches OPEN (first-hop readiness).
 *
 * @param {string} wsUrl - Normalized WS URL (`/api/ape`)
 * @param {Object} [options] - `{ timeout?: number }`
 * @returns {Promise<Object>}
 */
export function createRemoteDatabasePromise(wsUrl, options = {}) {
  let socket = null;
  let connected = false;
  let queryCounter = 0;
  const pendingQueries = new Map();
  const eventListeners = new Map();

  /**
   * Send one JSON-RPC envelope and correlate the response by `queryId`.
   *
   * @param {string} type - RPC method channel
   * @param {Object} payload
   * @returns {Promise<unknown>}
   */
  function rpc(type, payload) {
    return new Promise((resolve, reject) => {
      if (!connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      const queryId = `q_${++queryCounter}_${Date.now()}`;

      pendingQueries.set(queryId, { resolve, reject });

      const timeout = options.timeout || 30000;
      setTimeout(() => {
        if (pendingQueries.has(queryId)) {
          pendingQueries.delete(queryId);
          reject(new Error(`RPC timeout: ${type}`));
        }
      }, timeout);

      socket.send(JSON.stringify({ type, payload, queryId }));
    });
  }

  /**
   * Register a subscription listener for server-pushed `db:sub:` events.
   *
   * @param {string} type
   * @param {Function} listener
   * @returns {void}
   */
  function addEventListener(type, listener) {
    if (!eventListeners.has(type)) eventListeners.set(type, []);
    eventListeners.get(type).push(listener);
  }

  /**
   * Drop one listener reference for a subscription type.
   *
   * @param {string} type
   * @param {Function} listener
   * @returns {void}
   */
  function removeEventListener(type, listener) {
    if (eventListeners.has(type)) {
      const listeners = eventListeners.get(type);
      const i = listeners.indexOf(listener);
      if (i !== -1) listeners.splice(i, 1);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      settled = true;
      connected = true;
      resolve(
        buildRemoteDb(socket, rpc, addEventListener, removeEventListener)
      );
    };

    socket.onerror = (error) => {
      if (!settled) {
        reject(new Error(`WebSocket error: ${error.message || 'Connection failed'}`));
      }
    };

    socket.onclose = () => {
      connected = false;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.queryId && pendingQueries.has(data.queryId)) {
          const { resolve: res, reject: rej } = pendingQueries.get(data.queryId);
          pendingQueries.delete(data.queryId);
          if (data.error) {
            rej(new Error(data.error.message || 'Unknown error'));
          } else {
            res(data.result);
          }
        }

        if (data.type && data.type.startsWith('db:sub:')) {
          const subType = data.type.replace('db:sub:', '');
          const listeners = eventListeners.get(subType) || [];
          for (const listener of listeners) {
            try {
              listener(data.data);
            } catch (e) {
              console.error(`Error in subscription listener for ${subType}:`, e);
            }
          }
        }
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };
  });
}
