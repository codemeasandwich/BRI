/**
 * @file Deterministic embedding fixtures for vector tests.
 *
 * Real embeddings come from a model — far too expensive for unit tests.
 * The functions here produce reproducible synthetic vectors keyed by a
 * seed integer, normalized to unit length so cosine similarity is
 * well-defined. Two callers using the same seed get the same vector
 * across runs and across tests.
 *
 * Why a custom RNG instead of Math.random: tests must be deterministic
 * across Node versions and machines. The lehmer-style LCG below has the
 * same period and bias on every platform.
 *
 * Why normalize: the VectorIndex uses raw cosine distance (vector-index-
 * codec.js → cosine). If two test vectors had wildly different magnitudes,
 * the score could degenerate; normalizing keeps the test math predictable.
 */

const PRIME_A = 9301;
const PRIME_C = 49297;
const MODULUS = 233280;

/**
 * Build a normalized synthetic embedding of dim `dims` deterministically
 * from `seed`. Two calls with the same (seed, dims) return identical
 * vectors.
 *
 * @param {number} seed - Integer seed
 * @param {number} [dims=8] - Embedding dimensionality
 * @returns {Array<number>} unit-norm vector of length `dims`
 */
export function makeEmbedding(seed, dims = 8) {
  const out = new Array(dims);
  let s = seed >>> 0;
  for (let i = 0; i < dims; i++) {
    s = (s * PRIME_A + PRIME_C) % MODULUS;
    out[i] = (s / MODULUS) * 2 - 1;          // map [0,1) → [-1, 1)
  }
  // Unit-normalize.
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag) || 1;
  return out.map(v => v / mag);
}

/**
 * Build N embeddings keyed by sequential seeds starting at `start`.
 * Convenient when seeding a corpus where each document gets a distinct
 * vector but the suite needs every run to produce the same corpus.
 *
 * @param {number} count
 * @param {number} [dims=8]
 * @param {number} [start=1]
 * @returns {Array<Array<number>>}
 */
export function makeEmbeddings(count, dims = 8, start = 1) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(makeEmbedding(start + i, dims));
  return out;
}

/**
 * Build a query embedding offset slightly from a given seed so the
 * top-k search returns a known anchor. Useful for asserting "the
 * nearest neighbour is the one with the same seed".
 *
 * @param {number} seed - Anchor seed (caller embedded this id with seed)
 * @param {number} [dims=8]
 * @returns {Array<number>}
 */
export function nearVectorOf(seed, dims = 8) {
  // Generating with seed+1 produces a vector close in cosine space (the
  // LCG advances by one step, so most components are similar).
  return makeEmbedding(seed + 1, dims);
}
