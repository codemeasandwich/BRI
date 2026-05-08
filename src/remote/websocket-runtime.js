/**
 * @file Remote WebSocket runtime resolver.
 *
 * Domain context: Bri remote clients are public in both browser-like runtimes
 * and Node/Jest integration tests. Browser and Bun users usually have a
 * global WebSocket, while Node test harnesses may not expose one.
 *
 * Technical context: this helper keeps that runtime choice at the remote
 * transport boundary. It prefers `options.WebSocket` for explicit embedding,
 * then `globalThis.WebSocket`, then dynamically imports the existing `ws`
 * implementation for Node. Callers receive a constructor and never touch a
 * global directly.
 */

/**
 * Resolve the WebSocket constructor for a remote Bri connection.
 *
 * @param {Object} [options] - Remote connection options.
 * @param {Function} [options.WebSocket] - Explicit constructor override.
 * @returns {Promise<Function>} WebSocket constructor.
 */
export async function resolveWebSocketConstructor(options = {}) {
  if (typeof options.WebSocket === 'function') return options.WebSocket;
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    const mod = await import('ws');
    return mod.WebSocket || mod.default;
  } catch (err) {
    throw new Error(
      'Bri remote client requires a WebSocket implementation. ' +
      'Provide options.WebSocket, run in a runtime with global WebSocket, ' +
      'or install the ws package for Node.',
      { cause: err }
    );
  }
}
