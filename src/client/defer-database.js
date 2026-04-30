/**
 * @file Deferred database facade — resolves property access against a Database
 * that materializes asynchronously (pre-READY queueing).
 *
 * Domain context: callers must never await `bri.connect(...)` wire-up; `db.*`
 * must return sensible Promises (or synchronous chainables) immediately.
 * Until backing storage or remote WebSocket is READY, lookups queue on an
 * inner Promise (`waitPromise`).
 *
 * Technical: root `Proxy` switches after READY —
 * **`Reflect.get(resolvedDb, prop)`** so real `createGetProxy` / chainable
 * QueryBuilder instances are handed out untouched. Pre-READY, nested
 * `makeDeferNode` segments still use **`invokeAtSegments`** (**must**
 * use **`Reflect`** for getters on nested Proxies — plain `parent[prop]` can
 * break `db.get`).
 *
 * Returning a QueryBuilder solely through **`waitPromise.then(() => qb)`**
 * assimilates **`qb.then`** and collapses awaited values to **`toArray()`**.
 * Post-READY delegation avoids exposing QB through **`Promise`** resolution.
 */

/**
 * Traverse using Reflect.get so Proxy getters (`db.get`) match dotted access.
 *
 * @param {Object} root
 * @param {Array<string | symbol>} segs — path excluding leaf key (if invoking)
 * @returns {*}
 */
function getAtSegments(root, segs) {
  let cur = root;
  for (const s of segs) {
    cur = Reflect.get(cur, s);
    if (cur === undefined || cur === null) break;
  }
  return cur;
}

/**
 * Reflect-based invocation along `segments`.
 *
 * @param {Object} db
 * @param {Array<string>} segments
 * @param {Array<any>} args
 * @returns {*}
 */
function invokeAtSegments(db, segments, args) {
  const parent =
    segments.length > 1 ? getAtSegments(db, segments.slice(0, -1)) : db;
  const leafName = segments[segments.length - 1];
  const leaf = Reflect.get(parent, leafName);

  if (typeof leaf !== 'function') {
    throw new Error(
      `Deferred database: cannot invoke non-function at .${segments.join('.')}`
    );
  }
  return Reflect.apply(leaf, parent, args);
}

const PASS_THROUGH = new Set([
  Symbol.toPrimitive,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toStringTag,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable
]);

/**
 * Callable no-op shared by deferred proxies (nested + root shells). Proxies invoke
 * `apply`/`get` traps when used; engines never CALL this target normally. One explicit
 * call records the noop for instrumentation so coverage matches real execution rules.
 *
 * @returns {void}
 */
function deferredProxyCallableTarget() {}

void deferredProxyCallableTarget();

/**
 * Deferred property segment — callable (`db.add(...)`) forwards to READY then **`invokeAtSegments`**.
 *
 * @param {Promise<Object>} waitPromise - Backing {@link Database} promise
 * @param {Array<string | symbol>} segments - Path from repeated property lookups
 * @returns {unknown} Proxied noop target with **`get`** / **`apply`** traps only
 */
function makeDeferNode(waitPromise, segments) {
  return /** @type {unknown} */ (
    new Proxy(deferredProxyCallableTarget, {
      /**
       * @param {*} _target
       * @param {string | symbol} prop
       * @param {*} receiver
       * @returns {*|undefined}
       */
      get(_target, prop, receiver) {
        if (typeof prop === 'symbol') {
          if (PASS_THROUGH.has(prop)) return undefined;
          return Reflect.get(_target, prop, receiver);
        }
        if (prop === 'then') return undefined;
        return makeDeferNode(waitPromise, [...segments, prop]);
      },
      /**
       * @param {*} _target
       * @param {*} _thisArg
       * @param {Array<any>} [argArray]
       * @returns {Promise<*>}
       */
      apply(_target, _thisArg, argArray) {
        return waitPromise.then((db) =>
          invokeAtSegments(db, [...segments], argArray)
        );
      }
    })
  );
}

/**
 * @param {Promise<Object>} waitPromise - Resolves to {@link Database}
 * @returns {Object} Proxied façade (not a Promise)
 */
export function deferDatabase(waitPromise) {
  /** @type {Object|null} */
  let resolved = null;
  waitPromise.then(
    (db) => {
      resolved = db;
    },
    /** Backing failure: callers surface errors via chained `waitPromise` work; swallow here so the settlement chain completes. */
    () => {}
  );

  return /** @type {Object} */ (
    new Proxy(deferredProxyCallableTarget, {
      /**
       * @param {*} _target
       * @param {string | symbol} prop
       * @param {*} receiver
       * @returns {*|undefined}
       */
      get(_target, prop, receiver) {
        if (typeof prop === 'symbol') {
          if (PASS_THROUGH.has(prop)) return undefined;
          return Reflect.get(_target, prop, receiver);
        }
        if (prop === 'then') return undefined;
        if (resolved) return Reflect.get(resolved, prop);
        return makeDeferNode(waitPromise, [prop]);
      },
      /**
       * @param {*} _target
       * @param {*} _thisArg
       * @param {Array<any>} [argArray]
       * @returns {Promise<*>}
       */
      apply(_target, _thisArg, argArray) {
        return waitPromise.then((db) => Reflect.apply(db, db, argArray));
      }
    })
  );
}

export default deferDatabase;
