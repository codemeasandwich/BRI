/**
 * @file Main-thread host shim for the index-worker.
 *
 * Spawns the Worker Thread on first use and exposes a `WorkerVectorIndex`
 * class with the same surface the engine uses (`add`, `remove`, `search`,
 * `searchInTxn`, `addStaged`, `removeStaged`, `commit`, `rollback`,
 * `popStaged`, `stats`, `serialize`, `deserialize`). All operations cross
 * the worker boundary as a request/response pair correlated by an
 * incrementing id.
 *
 * The shim is opt-in for v1 — `BRI_VECTOR_WORKER` env var or direct use of
 * `createWorkerVectorIndex(opts)` are the only entry points. The default
 * registry continues to use the in-process VectorIndex; that's how the
 * 800+ existing tests stay on the main thread.
 *
 * Concurrency model:
 *   - Single worker per host instance — the host caches the Worker.
 *   - Requests are queued via Promise correlation (Map<id, {resolve,reject}>).
 *   - The worker handles requests serially; the main thread is free to
 *     issue new ones while older ones are in flight (Node's worker_threads
 *     uses a MessagePort with FIFO semantics).
 *
 * Error propagation:
 *   The worker serialises thrown errors into `{name, message, code, details}`
 *   and posts them back. The host reconstructs into an Error subclass that
 *   carries the `code` (so Bri typed-error consumers see it).
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';

let _sharedWorker = null;
let _nextRequestId = 1;
const _pending = new Map();

/**
 * Resolve a path to the worker script file relative to this module. The
 * worker script must be discoverable both in the source tree and after
 * a hypothetical bundling pass; using import.meta.url + a sibling file
 * works for both.
 *
 * @returns {string}
 */
function workerScriptPath() {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), 'index-worker.js');
}

/**
 * Lazily spawn the shared worker. Subsequent calls return the cached
 * instance. The worker is `unref()`'d so it does not keep the Node
 * process alive past test teardown.
 *
 * @returns {Worker}
 */
function getWorker() {
  if (_sharedWorker) return _sharedWorker;
  _sharedWorker = new Worker(workerScriptPath(), { type: 'module' });
  _sharedWorker.on('message', (msg) => {
    const pending = _pending.get(msg.id);
    if (!pending) return;
    _pending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.value);
    } else {
      const e = new Error(msg.error.message);
      e.name = msg.error.name || 'Error';
      if (msg.error.code) e.code = msg.error.code;
      if (msg.error.details) e.details = msg.error.details;
      pending.reject(e);
    }
  });
  _sharedWorker.on('error', (err) => {
    // Catastrophic worker failure: reject every in-flight request so
    // callers don't hang. Fresh requests after this point will spawn
    // a new worker.
    for (const { reject } of _pending.values()) reject(err);
    _pending.clear();
    _sharedWorker = null;
  });
  _sharedWorker.unref();
  return _sharedWorker;
}

/**
 * Send a request to the worker and resolve with its response value.
 *
 * @param {string} op
 * @param {Object} args
 * @returns {Promise<*>}
 */
function call(op, args) {
  const w = getWorker();
  const id = _nextRequestId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, op, args });
  });
}

/**
 * Async variant of VectorIndex that proxies every operation to the
 * shared index-worker. Public methods mirror VectorIndex 1:1; all
 * become Promises. Predicate functions are pre-resolved by the caller
 * to an array of allowed IDs (the worker has no main-thread context).
 *
 * Construction is two-phase: `new WorkerVectorIndex(opts)` is cheap
 * (no IPC); `await idx.ready()` triggers the `vector.create` request
 * so subsequent ops can assume the worker has the slot allocated.
 *
 * @class WorkerVectorIndex
 */
export class WorkerVectorIndex {
  /**
   * @param {Object} opts
   * @param {string} opts.collection
   * @param {number} opts.dims
   * @param {string} [opts.metric='cosine']
   * @param {number} [opts.M]
   * @param {number} [opts.efConstruction]
   * @param {number} [opts.efSearch]
   * @param {number|null} [opts.seed]
   */
  constructor(opts) {
    this.collection = opts.collection;
    this.dims = opts.dims;
    this.metric = opts.metric || 'cosine';
    this._initOpts = opts;
    this._readyPromise = null;
  }

  /**
   * Ensure `vector.create` has run — idempotent Promise cache.
   * @returns {Promise<void>}
   */
  ready() {
    if (!this._readyPromise) {
      this._readyPromise = call('vector.create', this._initOpts);
    }
    return this._readyPromise;
  }

  /**
   * @param {string} id - Document id
   * @param {ArrayLike<number>} vector - Embedding
   * @returns {Promise<void>}
   */
  async add(id, vector) {
    await this.ready();
    return call('vector.add', { collection: this.collection, id, vector });
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} Whether a row was removed
   */
  async remove(id) {
    await this.ready();
    return (await call('vector.remove', { collection: this.collection, id })).removed;
  }

  /**
   * Top-k cosine via worker `searchFiltered` with optional allowed-id predicate.
   * @param {ArrayLike<number>} vector - Query embedding
   * @param {number} k - Top-k
   * @param {Array<string>|Set<string>|null} [allowedIds] - Bounded candidate subset
   * @param {Object} [opts] - e.g. `{ efSearch }`
   * @returns {Promise<Array<{ id: string, score: number }>>}
   */
  async search(vector, k, allowedIds = null, opts) {
    await this.ready();
    const ids = allowedIds instanceof Set ? Array.from(allowedIds) : allowedIds;
    return call('vector.search',
      { collection: this.collection, vector: Array.from(vector), k, allowedIds: ids, opts });
  }

  /**
   * @param {ArrayLike<number>} vector
   * @param {number} k
   * @param {string} txnId
   * @param {Array<string>|Set<string>|null} [allowedIds]
   * @param {Object} [opts]
   * @returns {Promise<Array<{ id: string, score: number }>>}
   */
  async searchInTxn(vector, k, txnId, allowedIds = null, opts) {
    await this.ready();
    const ids = allowedIds instanceof Set ? Array.from(allowedIds) : allowedIds;
    return call('vector.searchInTxn',
      { collection: this.collection, vector: Array.from(vector), k, txnId, allowedIds: ids, opts });
  }

  /**
   * @param {string} txnId
   * @param {string} id
   * @param {ArrayLike<number>} vector
   * @returns {Promise<void>}
   */
  async addStaged(txnId, id, vector) {
    await this.ready();
    return call('vector.addStaged', { collection: this.collection, txnId, id, vector });
  }

  /**
   * @param {string} txnId
   * @param {string} id
   * @returns {Promise<void>}
   */
  async removeStaged(txnId, id) {
    await this.ready();
    return call('vector.removeStaged', { collection: this.collection, txnId, id });
  }

  /**
   * @param {string} txnId
   * @returns {Promise<void>}
   */
  async commit(txnId) {
    await this.ready();
    return call('vector.commit', { collection: this.collection, txnId });
  }

  /**
   * @param {string} txnId
   * @returns {Promise<void>}
   */
  async rollback(txnId) {
    await this.ready();
    return call('vector.rollback', { collection: this.collection, txnId });
  }

  /**
   * @param {string} txnId
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async popStaged(txnId, id) {
    await this.ready();
    return (await call('vector.popStaged', { collection: this.collection, txnId, id })).popped;
  }

  /**
   * @returns {Promise<Object>}
   */
  async stats() {
    await this.ready();
    return call('vector.stats', { collection: this.collection });
  }

  /**
   * @returns {Promise<Buffer>}
   */
  async serialize() {
    await this.ready();
    const { base64 } = await call('vector.serialize', { collection: this.collection });
    return Buffer.from(base64, 'base64');
  }

  /**
   * @param {Buffer} buf - Serialized worker payload
   * @returns {Promise<void>}
   */
  async deserialize(buf) {
    await this.ready();
    const base64 = Buffer.from(buf).toString('base64');
    return call('vector.deserialize', { collection: this.collection, base64 });
  }
}

/**
 * Factory that returns a worker-backed VectorIndex. Wraps construction +
 * `ready()` into a single await so callers don't have to remember the
 * two-phase init. Use this when offloading is required (UC-V5 bulk
 * insert, scale tests with `BRI_VECTOR_WORKER=true`).
 *
 * @param {Object} opts - VectorIndex constructor options + `collection`
 * @returns {Promise<WorkerVectorIndex>}
 */
export async function createWorkerVectorIndex(opts) {
  const idx = new WorkerVectorIndex(opts);
  await idx.ready();
  return idx;
}

/**
 * Read the worker's processed-op counter. Useful for the worker.test
 * smoke check that asserts the worker is actually exercised.
 *
 * @returns {Promise<{opCount:number}>}
 */
export function workerDiagnostics() {
  return call('diag.opCount', {});
}

/**
 * Tear down the shared worker (test cleanup). Idempotent. After this,
 * the next call() will spawn a fresh worker.
 *
 * @returns {Promise<void>}
 */
export async function disposeWorker() {
  if (!_sharedWorker) return;
  for (const { reject } of _pending.values()) {
    reject(new Error('Worker disposed before response'));
  }
  _pending.clear();
  await _sharedWorker.terminate();
  _sharedWorker = null;
}
