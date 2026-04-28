/**
 * @file Seedable PRNG + HNSW level-pick helper for the vector index.
 *
 * Role in the system:
 *   HNSW assigns each inserted node a "max level" sampled from a geometric
 *   distribution. The level decides how many neighbour layers a node lives
 *   in — most nodes sit only on level 0, a few are promoted to higher
 *   layers, and exactly one (the entry point) tops out at the graph's
 *   highest level. The randomness drives index topology, so for tests to
 *   be reproducible (and for snapshot bit-equality across re-inserts) the
 *   RNG must be seedable.
 *
 * Why Mulberry32:
 *   - 32-bit state, so seeding from `Math.random() * 2^32` covers the full
 *     state space when no explicit seed is supplied.
 *   - Statistically adequate for HNSW level assignment — we don't need
 *     cryptographic strength, only good distribution and no obvious bias
 *     across the geometric tail. xorshift would also work; Mulberry32 is
 *     marginally better at low bits of the output and is the modern
 *     default for "small fast PRNG in JS".
 *   - Pure JS, ~6 lines of arithmetic, no heap allocations per draw.
 *
 * Dependencies:
 *   None. This module is leaf-level — every HNSW caller imports it,
 *   nothing inside it imports anything else.
 *
 * Consumers:
 *   - engine/vector-index-hnsw.js — every insert calls pickLevel(rng, M)
 *   - engine/vector-index.js — constructs an RNG from {seed} or env at
 *     index creation time and hands it to the HNSW core
 *
 * Determinism contract:
 *   makeRng(seed) with the same integer seed returns a closure whose
 *   sequence of outputs is identical across runs, processes, and Node
 *   versions. No global state; each caller gets its own stream. This is
 *   what lets tests assert bit-identical snapshot output across two
 *   freshly-constructed indexes given the same insert sequence.
 */

/**
 * Construct a deterministic PRNG closure.
 *
 * Why a closure (not a class): the only operation needed is "next number"
 * — no need to expose the state. A closure keeps the call site terse and
 * the state private.
 *
 * Why coerce to uint32 with `>>> 0`: JS numbers are 64-bit floats; we want
 * the state to wrap at 2^32 so the arithmetic matches reference Mulberry32
 * implementations bit-for-bit. Without the coercion the state could drift
 * into integer-imprecise territory after many draws.
 *
 * @param {number|null} [seed] - Optional 32-bit unsigned integer. When
 *   null/undefined, a seed is drawn from Math.random() * 2^32 — i.e.
 *   non-deterministic, matching production-default behaviour.
 * @returns {() => number} draw() — returns the next number in [0, 1)
 */
export function makeRng(seed) {
  // Coerce the seed into a uint32. `(undefined ?? Math.random()*2^32) >>> 0`
  // produces a wide-spread random initial state when no seed is provided.
  let s = ((seed == null ? Math.random() * 0xffffffff : seed) >>> 0);
  return function draw() {
    // Mulberry32: classic 32-bit fast PRNG. Each step mutates the state
    // by adding a fixed odd constant, then mixes high and low halves
    // through Math.imul to spread bit influence before extracting the
    // top 32 bits as the output. The result is divided by 2^32 to
    // produce a float in [0, 1).
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample a node's max-level for HNSW insertion.
 *
 * Why this formula: HNSW's canonical level distribution is geometric with
 * decay parameter `mL = 1 / ln(M)`. The closed form is
 *   level = floor(-ln(uniform(0,1)) * mL).
 * Most draws produce 0 (so most nodes are level-0-only); a few percent
 * climb to level 1; far fewer reach level 2; and so on. The exponential
 * tail is what makes search O(log N) instead of O(N) — the entry node
 * sits high in the graph and each descent step drops by a constant
 * factor.
 *
 * Why we guard against `rng() === 0`: ln(0) is -Infinity, which would
 * propagate to a NaN level after the multiplication. The PRNG above can
 * in principle return 0 (when state lands exactly on a particular value);
 * substituting `Number.MIN_VALUE` keeps the geometric draw mathematically
 * sound and the resulting level finite.
 *
 * @param {() => number} rng - PRNG closure from makeRng
 * @param {number} M - HNSW M parameter (max neighbours per upper level);
 *   doubles as the geometric base via mL = 1/ln(M)
 * @returns {number} Non-negative integer level (0 = base layer only)
 */
export function pickLevel(rng, M) {
  const u = rng();
  // Substitute a tiny positive value when the draw is exactly 0 to keep
  // ln() finite. The probability is ~2^-32 in practice, but the guard is
  // free in cycles and prevents a hard-to-reproduce NaN crash.
  const safe = u > 0 ? u : Number.MIN_VALUE;
  return Math.floor(-Math.log(safe) * (1 / Math.log(M)));
}

export default { makeRng, pickLevel };
