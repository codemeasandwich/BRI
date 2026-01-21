/**
 * @file Server utility functions for connection state and serialization
 */

/** Per-connection state storage */
const connectionState = new WeakMap();

/**
 * Get or create connection state for a client WebSocket
 * @param {WebSocket} socket - The WebSocket connection
 * @returns {Object} Connection state object with entities, activeTxnId, and subscriptions
 */
export function getState(socket) {
  if (!connectionState.has(socket)) {
    connectionState.set(socket, {
      entities: new Map(),
      activeTxnId: null,
      subscriptions: new Map()
    });
  }
  return connectionState.get(socket);
}

/**
 * Remove connection state for a disconnected client
 * @param {WebSocket} socket - The WebSocket connection
 * @returns {boolean} Whether the state was deleted
 */
export function deleteState(socket) {
  return connectionState.delete(socket);
}

/**
 * Convert entity to plain object for transmission over WebSocket
 * @param {*} entity - Entity or value to convert
 * @returns {*} Plain object representation
 */
export function toPlainObject(entity) {
  if (!entity) return entity;

  if (Array.isArray(entity)) {
    return entity.map(toPlainObject);
  }

  if (typeof entity === 'object') {
    if (typeof entity.toObject === 'function') {
      return entity.toObject();
    }

    const plain = {};
    for (const [key, value] of Object.entries(entity)) {
      if (typeof value !== 'function' && key !== 'and') {
        plain[key] = value;
      }
    }
    return plain;
  }

  return entity;
}
