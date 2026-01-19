/**
 * @file BRI Remote Client
 *
 * Provides the identical BRI API over WebSocket using api-ape.
 *
 * Usage:
 *   import { apiDB } from 'bri';
 *   const db = await apiDB();
 *
 *   // Same API as local BRI!
 *   const user = await db.add.user({ name: 'Alice' });
 *   const post = await db.get.post(postId).and.author;
 *   user.name = 'Bob';
 *   await user.save();
 *
 * Alternative import:
 *   import { createRemoteDB } from 'bri/remote';
 *   const db = await createRemoteDB('ws://localhost:3000');
 */

import { createOperationProxy } from './proxy.js';
import { wrapEntity } from './entity.js';

/**
 * Create a remote BRI database connection
 * @param {string} url - WebSocket URL (e.g., 'ws://localhost:3000')
 * @param {Object} options - Connection options
 * @returns {Promise<Object>} - Database interface (same API as local BRI)
 */
export async function createRemoteDB(url, options = {}) {
  // Normalize URL to include /api/ape path if not present
  const wsUrl = url.endsWith('/api/ape') ? url : `${url}/api/ape`;

  // Connection state
  let socket = null;
  let connected = false;
  let queryCounter = 0;
  const pendingQueries = new Map();
  const eventListeners = new Map();

  /**
   * Connect to the server
   * @returns {Promise<void>}
   */
  function connect() {
    return new Promise((resolve, reject) => {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        connected = true;
        resolve();
      };

      socket.onerror = (error) => {
        reject(new Error(`WebSocket error: ${error.message || 'Connection failed'}`));
      };

      socket.onclose = () => {
        connected = false;
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle response to a query
          if (data.queryId && pendingQueries.has(data.queryId)) {
            const { resolve, reject } = pendingQueries.get(data.queryId);
            pendingQueries.delete(data.queryId);

            if (data.error) {
              reject(new Error(data.error.message || 'Unknown error'));
            } else {
              resolve(data.result);
            }
          }

          // Handle subscription events (server-pushed)
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

  /**
   * Send RPC call to server
   * @param {string} type - RPC type (e.g., 'db/get/user')
   * @param {Object} payload - Request payload
   * @returns {Promise<any>}
   */
  function rpc(type, payload) {
    return new Promise((resolve, reject) => {
      if (!connected) {
        reject(new Error('Not connected to server'));
        return;
      }

      const queryId = `q_${++queryCounter}_${Date.now()}`;

      pendingQueries.set(queryId, { resolve, reject });

      // Set timeout
      const timeout = options.timeout || 30000;
      setTimeout(() => {
        if (pendingQueries.has(queryId)) {
          pendingQueries.delete(queryId);
          reject(new Error(`RPC timeout: ${type}`));
        }
      }, timeout);

      socket.send(JSON.stringify({
        type,
        payload,
        queryId
      }));
    });
  }

  /**
   * Add event listener for subscriptions
   * @param {string} type - Event type
   * @param {Function} listener - Callback function
   */
  function addEventListener(type, listener) {
    if (!eventListeners.has(type)) {
      eventListeners.set(type, []);
    }
    eventListeners.get(type).push(listener);
  }

  /**
   * Remove event listener
   * @param {string} type - Event type
   * @param {Function} listener - Callback to remove
   */
  function removeEventListener(type, listener) {
    if (eventListeners.has(type)) {
      const listeners = eventListeners.get(type);
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }

  // Connect to server
  await connect();

  // Track active transaction ID for visibility
  let _activeTxnId = null;

  // Create the database interface
  const db = {
    // CRUD operation proxies
    get: createOperationProxy('get', rpc, wrapEntity),
    add: createOperationProxy('add', rpc, wrapEntity),
    set: createOperationProxy('set', rpc, wrapEntity),
    del: createOperationProxy('del', rpc, wrapEntity),

    // Expose active transaction ID for debugging/testing
    get _activeTxnId() { return _activeTxnId; },

    // Subscription proxy
    sub: new Proxy({}, {
      /** @param {Object} target @param {string} collection @returns {Function} */
      get(target, collection) {
        return async (callback) => {
          // Register local listener
          addEventListener(collection, callback);

          // Tell server to subscribe
          await rpc(`db/sub/${collection}`, { type: collection });

          // Return unsubscribe function
          return () => {
            removeEventListener(collection, callback);
            rpc(`db/unsub/${collection}`, { type: collection }).catch(() => {});
          };
        };
      }
    }),

    /** Start a transaction @returns {Promise<string>} Transaction ID */
    rec() {
      return rpc('db/txn/rec', {}).then(r => {
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

    /** Undo last action in transaction @param {string} [txnId] @returns {Promise<Object>} */
    async pop(txnId) {
      return rpc('db/txn/pop', { txnId: txnId || _activeTxnId });
    },

    /** Get transaction status @param {string} [txnId] @returns {Promise<Object>} */
    txnStatus(txnId) {
      return rpc('db/txn/status', { txnId: txnId || _activeTxnId });
    },

    /** Close the WebSocket connection @returns {Promise<void>} */
    async disconnect() {
      if (socket) {
        socket.close();
        socket = null;
        connected = false;
      }
    },

    // Expose internal RPC for advanced use
    _rpc: rpc,
    _connected: () => connected
  };

  return db;
}

/**
 * apiDB - Alias for createRemoteDB with default URL
 *
 * @param {string} url - WebSocket URL (default: 'ws://localhost:3000')
 * @returns {Promise<Object>} - Database interface
 */
export async function apiDB(url = 'ws://localhost:3000') {
  return createRemoteDB(url);
}

export default createRemoteDB;
