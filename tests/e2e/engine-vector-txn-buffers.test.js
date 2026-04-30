/**
 * @file UC-V4 internals — transactional vector buffer primitives
 *
 * The buffer logic lives in `engine/vector-index-txn.js` and is normally
 * driven by middleware + txn lifecycle (`db.rec`/`fin`/`pop`). Exercise the
 * `VectorIndex` surface exported from `package.json`'s `./engine` binding so
 * every branch stays reachable via a documented specifier without deep imports:
 * deterministic vectors, staged add/remove interplay, predicate merge joins,
 * pop paths (empty bucket, wrong id, last-op bucket delete vs multi-op retains),
 * commit applyAdd/applyRemove pairs, unknown-op fallthrough in commit and merge,
 * and rollback.
 */

import { describe, test, expect } from '@jest/globals';
import {
  VectorIndex,
  VECTOR_QUERY_DIMS_MISMATCH,
  BriQueryError
} from '../../src/engine/index.js';

const DIM = 8;

/** Normalized deterministic dim-vector for cosine tests */
function vec(seed) {
  const v = new Array(DIM);
  let s = 0;
  let h = Math.abs(seed) + 17;
  for (let i = 0; i < DIM; i++) {
    h = (h * 1103515245 + i) >>> 0;
    v[i] = (h % 1000) / 1000 - 0.5;
    s += v[i] * v[i];
  }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

describe('VectorIndex txn buffer (exported `./engine`)', () => {
  test('BriError omits details unless the constructor received a details object', () => {
    const without = new BriQueryError({
      message: 'm1',
      code: 'VECTOR_FIELD_NOT_DECLARED'
    });
    expect(without.details).toBeUndefined();

    const withDetail = new BriQueryError({
      message: 'm2',
      code: 'VECTOR_FIELD_NOT_DECLARED',
      details: { field: 'embedding' }
    });
    expect(withDetail.details.field).toBe('embedding');
  });

  test('addStaged throws when staged vector length mismatches dims (defensive guard)', () => {
    const idx = new VectorIndex({ dims: DIM });
    expect(() => idx.addStaged('tx1', 'DOC_x', vec(3).slice(0, DIM - 1))).toThrow(
      /dimension mismatch/
    );
  });

  test('removeStaged creates a txn bucket without a prior staged add', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.removeStaged('tx2', 'orphan_rm');
    const bucket = idx._pending.get('tx2');
    expect(bucket).toHaveLength(1);
    expect(bucket[0]).toEqual({ op: 'remove', id: 'orphan_rm', vec: null });
  });

  test('commit applies a staged remove-only op (topology remove when absent is safe)', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.removeStaged('tx3', 'no_such_commit');
    idx.commit('tx3');
    expect(idx._pending.has('tx3')).toBe(false);
  });

  /**
   * commitTxn must invoke applyAdd for staged adds; remove-only commits never
   * cross the `if (op === 'add')` arm. This keeps HNSW slots alive for real
   * staged-add→commit flows (middleware flush) and exercises applyAdd/applyRemove
   * in one txn list.
   */
  test('commit applies staged add then remove in order (applyAdd and applyRemove both run)', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('tx_add_rm', 'live', vec(11));
    idx.removeStaged('tx_add_rm', 'ghost');
    idx.commit('tx_add_rm');
    expect(idx._pending.has('tx_add_rm')).toBe(false);
    expect(idx._slotOf.has('live')).toBe(true);
    expect(idx._slotOf.has('ghost')).toBe(false);
  });

  /**
   * commitTxn only matches 'add' and 'remove'. Unknown op entries are ignored
   * (no apply call) but still consumed so the bucket can empty — matches the
   * defensive shape tolerated in searchInTxnMerged.
   */
  test('commit ignores unknown pending op codes and still flushes real adds', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('tx_badop', 'ok', vec(31));
    const bucket = idx._pending.get('tx_badop');
    bucket.unshift({ op: 'noop', id: 'x', vec: null });
    idx.commit('tx_badop');
    expect(idx._pending.has('tx_badop')).toBe(false);
    expect(idx._slotOf.has('ok')).toBe(true);
  });

  /**
   * popStagedOp deletes the txn bucket only when the last op is spliced out.
   * If other ops remain, the bucket stays so later pop/commit paths still see
   * the same txnId (branch: ops.length > 0 after splice).
   */
  test('popStaged with multiple pending ops leaves the txn bucket when not empty', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('tx_multi', 'first', vec(21));
    idx.addStaged('tx_multi', 'second', vec(22));
    expect(idx.popStaged('tx_multi', 'second')).toBe(true);
    expect(idx._pending.has('tx_multi')).toBe(true);
    expect(idx._pending.get('tx_multi').some((o) => o.id === 'first')).toBe(true);
  });

  test('popStaged misses when pending bucket is empty', () => {
    const idx = new VectorIndex({ dims: DIM });
    expect(idx.popStaged('tx4', 'any')).toBe(false);
  });

  test('popStaged misses when bucket has staging for a different id', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('tx5', 'A', vec(1));
    expect(idx.popStaged('tx5', 'different')).toBe(false);
  });

  test('merged txn search honours predicate skipping both committed and staged adds', () => {
    const idx = new VectorIndex({ dims: DIM });
    const v1 = vec(101);
    const v2 = vec(202);
    idx.add('committed_keep', v1);
    idx.add('committed_drop', v2);
    // Staged add that should survive predicate filtering
    idx.addStaged('txp', 'staged_good', vec(303));
    // Staged sequence that clears then re-inserts staged_good (remove→add interplay)
    idx.removeStaged('txp', 'staged_scratch');
    idx.addStaged('txp', 'staged_scratch', vec(404));
    const q = vec(101);
    const pred = (id) => id === 'committed_keep' || id.startsWith('staged_');
    const hits = idx.searchInTxn(q, 5, 'txp', pred);
    const ids = new Set(hits.map((h) => h.id));
    expect(ids.has('committed_drop')).toBe(false);
    expect(ids.has('staged_scratch')).toBe(true);
  });

  test('searchInTxn merges many staged adds then truncates to k via merge sort cap', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.add('seed', vec(501));
    for (let i = 0; i < 5; i++) {
      idx.addStaged('widetx', `S${i}`, vec(900 + i));
    }
    const q = vec(900);
    const merged = idx.searchInTxn(q, 2, 'widetx', null);
    expect(merged.length).toBeLessThanOrEqual(2);
  });

  test('searchInTxn throws VECTOR_QUERY_DIMS_MISMATCH on bad query dims', () => {
    const idx = new VectorIndex({ dims: DIM });
    let caught;
    try {
      idx.searchInTxn(new Array(DIM - 3).fill(0.1), 1, 'tq', null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe(VECTOR_QUERY_DIMS_MISMATCH);
  });

  test('committed search inside merge honours removal filter (stagedAdds drop on remove)', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('mergex', 'flip', vec(707));
    idx.removeStaged('mergex', 'flip');
    idx.addStaged('mergex', 'flip', vec(808));
    const q = vec(808);
    const out = idx.searchInTxn(q, 4, 'mergex', null);
    const flip = out.find((h) => h.id === 'flip');
    expect(flip && flip.score > 0.99).toBe(true);
  });

  test('rollback drops pending buckets without flushing to the committed graph', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('rbtx', 'ghost', vec(12));
    idx.rollback('rbtx');
    expect(idx._pending.has('rbtx')).toBe(false);
    expect(idx._slotOf.has('ghost')).toBe(false);
  });

  test('commit is a no-op when no pending bucket exists for the txn id', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.add('solo', vec(777));
    expect(() => idx.commit('no_bucket_txn')).not.toThrow();
    expect(idx._pending.has('no_bucket_txn')).toBe(false);
  });

  test('popStaged on the lone pending op clears the txn bucket entirely', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('txlonely', 'one', vec(3));
    expect(idx.popStaged('txlonely', 'one')).toBe(true);
    expect(idx._pending.has('txlonely')).toBe(false);
  });

  test('searchInTxn with no staged ops for txn falls back through empty pending list', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.add('docA', vec(11));
    const q = vec(11);
    const hits = idx.searchInTxn(q, 5, 'never_used_txn_id', null);
    expect(hits.some((h) => h.id === 'docA')).toBe(true);
  });

  test('searchInTxn skips staged-add ids rejected by predicate', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('predtx', 'allow', vec(303));
    idx.addStaged('predtx', 'block', vec(909));
    const q = vec(303);
    const hits = idx.searchInTxn(q, 10, 'predtx', (id) => id === 'allow');
    expect(hits.some((h) => h.id === 'block')).toBe(false);
    expect(hits.some((h) => h.id === 'allow')).toBe(true);
  });

  test('searchInTxnMerged replaces committed hit when staged add overrides same id', () => {
    const idx = new VectorIndex({ dims: DIM });
    const oldVec = vec(501);
    const newVec = vec(502);
    idx.add('repId', oldVec);
    idx.addStaged('reptxn', 'repId', newVec);
    const q = newVec;
    const hits = idx.searchInTxn(q, 5, 'reptxn', null);
    const row = hits.find((h) => h.id === 'repId');
    expect(row).toBeDefined();
    expect(row.score).toBeGreaterThan(0.999);
  });

  test('searchInTxn injects purely staged ids when committed index has no matching row', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('stonly', 'phantom', vec(801));
    const q = vec(801);
    const hits = idx.searchInTxn(q, 3, 'stonly', null);
    expect(hits.some((h) => h.id === 'phantom')).toBe(true);
  });

  /**
   * searchInTxnMerged iterates staged ops assuming op is 'remove'|'add'.
   * Defensive fallback: junk rows neither add nor extend staged maps; we reach
   * this via the internal pending bucket shape (crash-injection tolerance), not
   * via addStaged/removeStaged alone.
   */
  test('searchInTxn skips unknown pending op codes without throwing', () => {
    const idx = new VectorIndex({ dims: DIM });
    idx.addStaged('tx_junk', 'good', vec(501));
    const bucket = idx._pending.get('tx_junk');
    bucket.unshift({ op: 'noop', id: 'junk', vec: null });
    const q = vec(501);
    const hits = idx.searchInTxn(q, 5, 'tx_junk', null);
    expect(hits.some((h) => h.id === 'good')).toBe(true);
  });
});
