/**
 * @file WebSocket connection wrapper for BRI remote client
 *
 * Provides promise-based send/receive with queryId correlation,
 * event subscription for broadcasts, and connection management.
 */

/**
 * Create a WebSocket connection to the BRI server
 * @param {string} url - WebSocket URL (e.g., 'ws://localhost:3000/api/ape')
 * @returns {Promise<Object>} Connection interface with send, on, close methods
 */
export async function createConnection(url) {
  let ws;
  let queryCounter = 0;
  const pending = new Map();    // queryId → { resolve, reject, timer }
  const listeners = new Map();  // type → Set<callback>

  // Default timeout for requests (10 seconds)
  const REQUEST_TIMEOUT = 10000;

  /**
   * Establish WebSocket connection
   * @returns {Promise<void>}
   */
  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log('[BRI Remote] Connected to', url);
        resolve();
      };

      ws.onerror = (err) => {
        console.error('[BRI Remote] Connection error:', err);
        reject(new Error('WebSocket connection failed'));
      };

      ws.onmessage = handleMessage;

      ws.onclose = (event) => {
        console.log('[BRI Remote] Connection closed:', event.code, event.reason);
        // Reject all pending requests
        for (const [queryId, { reject, timer }] of pending) {
          clearTimeout(timer);
          reject(new Error('Connection closed'));
        }
        pending.clear();
      };
    });
  }

  /**
   * Handle incoming WebSocket messages
   * @param {MessageEvent} event - WebSocket message event
   */
  function handleMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('[BRI Remote] Invalid JSON:', event.data);
      return;
    }

    // Check if this is a response to a pending request
    if (msg.queryId && pending.has(msg.queryId)) {
      const { resolve, reject, timer } = pending.get(msg.queryId);
      clearTimeout(timer);
      pending.delete(msg.queryId);

      if (msg.error) {
        reject(new Error(msg.error.message || 'Unknown error'));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Otherwise, dispatch as a broadcast/subscription event
    if (msg.type && listeners.has(msg.type)) {
      const callbacks = listeners.get(msg.type);
      for (const cb of callbacks) {
        try {
          cb(msg.data);
        } catch (e) {
          console.error('[BRI Remote] Listener error:', e);
        }
      }
    }
  }

  /**
   * Send a request and wait for response
   * @param {string} type - RPC type (e.g., 'db/get/user')
   * @param {Object} payload - Request payload
   * @returns {Promise<any>} Server response
   */
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      const queryId = `q${++queryCounter}`;

      // Set timeout
      const timer = setTimeout(() => {
        pending.delete(queryId);
        reject(new Error(`Request timeout: ${type}`));
      }, REQUEST_TIMEOUT);

      pending.set(queryId, { resolve, reject, timer });

      const message = JSON.stringify({ type, payload, queryId });
      ws.send(message);
    });
  }

  /**
   * Subscribe to broadcast events
   * @param {string} type - Event type (e.g., 'db:sub:user')
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  function on(type, callback) {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    listeners.get(type).add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = listeners.get(type);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          listeners.delete(type);
        }
      }
    };
  }

  /**
   * Close the connection
   */
  function close() {
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  /**
   * Check if connected
   * @returns {boolean}
   */
  function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  // Establish connection
  await connect();

  return {
    send,
    on,
    close,
    isConnected
  };
}
