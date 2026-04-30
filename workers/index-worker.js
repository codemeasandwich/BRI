/**
 * @file Worker-Thread entry point for vector + graph index operations.
 *
 * Per spec §3.2: index operations may be offloaded to a Worker Thread so
 * bulk inserts (UC-V5) and CPU-bound searches do not block the request
 * path. v1 ships this worker as opt-in: enable **`BRI_VECTOR_WORKER`** per
 * `workers/vector-worker-env.js`, or invoke `workers/index-worker-host.js`
 * → `createWorkerVectorIndex` directly;
 * the default main-thread path is unchanged. v2 may make the worker the
 * default once the latency gates of §6.2 require it.
 *
 * Protocol (parentPort message channel):
 *   request:  { id, op, args }                    — id correlates request to response
 *   response: { id, ok: true, value }             — successful operation
 *             { id, ok: false, error: { ... } }   — error propagated to host
 *
 * Operations:
 *   vector.create({ collection, dims, metric, M, efConstruction, efSearch, seed })
 *   vector.add({ collection, id, vector })
 *   vector.remove({ collection, id })
 *   vector.search({ collection, vector, k, allowedIds?, opts? })
 *   vector.searchInTxn({ collection, vector, k, txnId, allowedIds?, opts? })
 *   vector.addStaged({ collection, txnId, id, vector })
 *   vector.removeStaged({ collection, txnId, id })
 *   vector.commit({ collection, txnId })
 *   vector.rollback({ collection, txnId })
 *   vector.popStaged({ collection, txnId, id })
 *   vector.stats({ collection })
 *   vector.serialize({ collection })
 *   vector.deserialize({ collection, base64 })
 *   diag.opCount()
 *
 * Why an allowed-ID set instead of a serialized predicate function:
 *   The host pre-computes the candidate set on the main thread (it has
 *   the planner + secondary indexes) and ships only the resulting Set
 *   across the boundary. Eval-ing a predicate string in the worker is a
 *   sandbox-escape risk and was explicitly rejected by the plan.
 */

import { parentPort } from 'worker_threads';
import { VectorIndex } from '../engine/vector-index.js';

/** Active per-collection VectorIndex instances. */
const indices = new Map();

/** Counter exposed via diag.opCount for the worker.test smoke check. */
let opCount = 0;

/**
 * Resolve and return the VectorIndex for a named collection.
 *
 * @param {string} collection
 * @returns {VectorIndex}
 * @throws {Error} when the collection has not been registered via vector.create
 */
function indexFor(collection) {
  const idx = indices.get(collection);
  if (!idx) {
    throw new Error(
      `index-worker: collection '${collection}' has no registered VectorIndex; ` +
      `host must call vector.create before any add/search.`
    );
  }
  return idx;
}

/**
 * Build a predicate function from an allowed-ID set sent over the wire.
 * Returns null if the request didn't constrain candidates — a null
 * predicate means "consider all entries".
 *
 * @param {Array<string>|null|undefined} allowedIds
 * @returns {((id:string)=>boolean)|null}
 */
function predicateFromIds(allowedIds) {
  if (!allowedIds) return null;
  const set = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
  return (id) => set.has(id);
}

/** Operation table — keyed by `op` string from the host request. */
const ops = {
  'vector.create': ({ collection, dims, metric, M, efConstruction, efSearch, seed }) => {
    if (indices.has(collection)) return { ok: true };
    indices.set(collection,
      new VectorIndex({ dims, metric, M, efConstruction, efSearch, seed }));
    return { ok: true };
  },

  'vector.add': ({ collection, id, vector }) => {
    indexFor(collection).add(id, vector);
    return { ok: true };
  },

  'vector.remove': ({ collection, id }) => {
    return { removed: indexFor(collection).remove(id) };
  },

  'vector.search': ({ collection, vector, k, allowedIds, opts }) => {
    const pred = predicateFromIds(allowedIds);
    return indexFor(collection).searchFiltered(vector, k, pred, opts);
  },

  'vector.searchInTxn': ({ collection, vector, k, txnId, allowedIds, opts }) => {
    const pred = predicateFromIds(allowedIds);
    return indexFor(collection).searchInTxn(vector, k, txnId, pred, opts);
  },

  'vector.addStaged': ({ collection, txnId, id, vector }) => {
    indexFor(collection).addStaged(txnId, id, vector);
    return { ok: true };
  },

  'vector.removeStaged': ({ collection, txnId, id }) => {
    indexFor(collection).removeStaged(txnId, id);
    return { ok: true };
  },

  'vector.commit': ({ collection, txnId }) => {
    indexFor(collection).commit(txnId);
    return { ok: true };
  },

  'vector.rollback': ({ collection, txnId }) => {
    indexFor(collection).rollback(txnId);
    return { ok: true };
  },

  'vector.popStaged': ({ collection, txnId, id }) => {
    return { popped: indexFor(collection).popStaged(txnId, id) };
  },

  'vector.stats': ({ collection }) => indexFor(collection).stats(),

  'vector.serialize': ({ collection }) => {
    const buf = indexFor(collection).serialize();
    return { base64: Buffer.from(buf).toString('base64') };
  },

  'vector.deserialize': ({ collection, base64 }) => {
    indices.set(collection, VectorIndex.deserialize(Buffer.from(base64, 'base64')));
    return { ok: true };
  },

  'diag.opCount': () => ({ opCount })
};

/**
 * Dispatch a single request from the host — wraps op lookup in try/catch
 * so failures serialize over the wire.
 *
 * @param {Object} msg - Posted payload `{ id, op, args }`
 * @param {number} msg.id - Request correlation id
 * @param {string} msg.op - Operation key (e.g. `vector.add`)
 * @param {Object} [msg.args] - Payload for the op handler
 */
function handle(msg) {
  const { id, op, args } = msg;
  try {
    const handler = ops[op];
    if (!handler) {
      throw new Error(`index-worker: unknown op '${op}'`);
    }
    const value = handler(args || {});
    opCount += 1;
    parentPort.postMessage({ id, ok: true, value });
  } catch (e) {
    // Serialise the error: error instances do not survive structured
    // clone if they carry symbol-keyed properties; spread plain fields.
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        name: e.name || 'Error',
        message: e.message || String(e),
        code: e.code,
        details: e.details
      }
    });
  }
}

if (parentPort) {
  parentPort.on('message', handle);
}
