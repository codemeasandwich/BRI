/**
 * @file Minimal **`ws`** `WebSocketServer` RPC fake for Bri remote integration tests.
 *
 * Mirrors the server's `{ queryId, payload } → { queryId, result | error }` framing so
 * **`bri.connect({ url })`** OPEN plus buffered `_rpc` probes run entirely in-process.
 */

import { WebSocketServer } from 'ws';

/** @typedef {{ port: number; close: () => Promise<void> }} MockServerHandle */

/**
 * Start a server that echoes RPC payloads in `{ queryId, result }` shape.
 *
 * @returns {Promise<MockServerHandle>}
 */
export async function startMockWsRpcServer() {
  /** @type {WebSocketServer} */
  const wss = new WebSocketServer({ port: 0 });

  await new Promise((resolve, reject) => {
    wss.on('listening', resolve);
    wss.on('error', reject);
  });

  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const { queryId, type, payload } = msg;
        ws.send(
          JSON.stringify({
            queryId,
            result: { type, payload },
            error: null
          })
        );
      } catch (e) {
        ws.send(JSON.stringify({ error: { message: String(e) } }));
      }
    });
  });

  return {
    port,
    close: () =>
      new Promise((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
