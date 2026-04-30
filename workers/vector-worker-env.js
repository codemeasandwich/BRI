/**
 * @file Parsing rules for whether we should preload the optional vector Worker
 * thread (`BRI_VECTOR_WORKER`). Lives in its own tiny module without pulling
 * `worker_threads`, so local bootstrap (`bri.connect` / `openLocalDatabase`) can branch before dynamic-importing
 * the heavier `index-worker-host.js` shim.
 *
 * Accepted values — trimmed, ASCII case-folded (`toLowerCase`):
 *   `true`, `1`, `yes`, `on` — enable eager warm (`warmVectorWorkerFromEnv`).
 *
 * Explicit opt-out markers `0`, `false`, `no`, `off`, empty-string → no warm even if
 * a previous process left garbage in inherited env vars (corner case in flaky CI).
 *
 * Undefined / absent variable → disabled (preserve default in-process VectorIndex only).
 */

const ENABLE = new Set(['true', '1', 'yes', 'on']);
const DISABLE = new Set(['0', 'false', 'no', 'off']);

/**
 * @returns {boolean} Whether callers should preload the Worker host for
 *   `createWorkerVectorIndex`/diagnostics ergonomics — not registry substitution.
 */
export function isVectorWorkerWarmRequestedFromEnv() {
  if (typeof process === 'undefined' || !process.env) return false;
  const raw = process.env.BRI_VECTOR_WORKER;
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return false;
  if (DISABLE.has(s)) return false;
  return ENABLE.has(s);
}
