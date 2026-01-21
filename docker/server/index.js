/**
 * @file BRI + api-ape Server
 *
 * Exposes BRI database operations via WebSocket RPC.
 * Clients can use the identical BRI API through the remote wrapper.
 */

import { createDB } from '../../index.js';
import { getState, deleteState } from './utils.js';
import { handleRPC } from './handlers.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';
const MAX_MEMORY_MB = parseInt(process.env.MAX_MEMORY_MB || '256', 10);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || undefined;
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true';

let db;

/**
 * Initialize BRI database
 * @returns {Promise<Object>} Database instance
 */
async function initDatabase() {
  console.log(`[BRI] Initializing database...`);
  console.log(`[BRI] Data directory: ${DATA_DIR}`);
  console.log(`[BRI] Max memory: ${MAX_MEMORY_MB}MB`);
  console.log(`[BRI] Encryption: ${ENCRYPTION_KEY ? 'enabled' : 'disabled'}`);

  db = await createDB({
    storeConfig: {
      dataDir: DATA_DIR,
      maxMemoryMB: MAX_MEMORY_MB,
      encryptionKey: ENCRYPTION_KEY
    }
  });

  console.log(`[BRI] Database ready`);
  return db;
}

/**
 * Create Bun HTTP server with WebSocket support
 * @returns {Object} Server instance
 */
function createServer() {
  return Bun.serve({
    port: PORT,

    /**
     * Handle HTTP requests
     * @param {Request} req - HTTP request
     * @param {Object} server - Server instance
     * @returns {Response|undefined} HTTP response
     */
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === '/api/ape/ping') {
        return new Response(JSON.stringify({
          ok: true,
          timestamp: Date.now()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (url.pathname === '/api/ape') {
        const upgraded = server.upgrade(req, {
          data: { connectedAt: Date.now() }
        });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      /**
       * Handle new WebSocket connection
       * @param {WebSocket} ws - WebSocket connection
       * @returns {void}
       */
      open(ws) {
        console.log(`[WS] Client connected`);
        getState(ws);
      },

      /**
       * Handle WebSocket disconnection
       * @param {WebSocket} ws - WebSocket connection
       * @returns {void}
       */
      close(ws) {
        console.log(`[WS] Client disconnected`);
        const state = getState(ws);

        for (const [type, unsubscribe] of state.subscriptions) {
          try {
            unsubscribe();
          } catch (e) {
            console.error(`[WS] Error unsubscribing from ${type}:`, e);
          }
        }

        if (state.activeTxnId) {
          db.nop().catch(e => {
            console.error('[WS] Error canceling transaction:', e);
          });
        }

        deleteState(ws);
      },

      /**
       * Handle WebSocket message
       * @param {WebSocket} ws - WebSocket connection
       * @param {Buffer|string} message - Received message
       * @returns {Promise<void>}
       */
      async message(ws, message) {
        try {
          const data = JSON.parse(message.toString());
          const { type, payload, queryId } = data;

          const result = await handleRPC(db, ws, type, payload);

          ws.send(JSON.stringify({
            queryId,
            result,
            error: null
          }));
        } catch (error) {
          console.error('[WS] Error handling message:', error);

          try {
            const data = JSON.parse(message.toString());
            ws.send(JSON.stringify({
              queryId: data.queryId,
              result: null,
              error: {
                message: error.message,
                code: error.code || 'UNKNOWN_ERROR'
              }
            }));
          } catch (e) {
            ws.send(JSON.stringify({
              error: { message: 'Invalid message format' }
            }));
          }
        }
      }
    }
  });
}

/**
 * Main entry point
 * @returns {Promise<void>}
 */
async function main() {
  console.log('========================================');
  console.log('  BRI + api-ape Server');
  console.log('========================================');

  await initDatabase();

  const server = createServer();

  console.log(`[Server] Listening on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/api/ape`);
  console.log(`[Server] Auth required: ${AUTH_REQUIRED}`);
  console.log('========================================');

  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await db.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Server] Shutting down...');
    await db.disconnect();
    process.exit(0);
  });
}

export { db, getState };

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
