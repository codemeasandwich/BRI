/**
 * @file E2E — WAL record-type vocabulary and replay routing
 *
 * Operators and future workers may emit index- and vector-tier WAL lines
 * (spec §3.3) alongside document SET/DELETE. Recovery’s document replay path
 * must ignore those markers without treating them as corrupt, while still
 * surfacing truly unknown action strings.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { serializeEntry } from '../../storage/wal/entry.js';
import { WALReader } from '../../storage/wal/reader.js';
import {
  isDocumentRecord,
  isVectorRecord,
  isSecondaryIndexRecord,
  WAL_RECORD_TYPES,
  INDEX_INSERT,
  INDEX_UPDATE,
  VECTOR_ADD,
  VECTOR_COMMIT_TXN
} from '../../storage/wal/record-types.js';

const baseDir = './test-data-wal-record-types';

describe('WAL record-type helpers (domain vocabulary)', () => {
  test('document vs index vs vector classification matches spec buckets', () => {
    expect(isDocumentRecord(WAL_RECORD_TYPES.SET)).toBe(true);
    expect(isDocumentRecord('UNKNOWN')).toBe(false);

    expect(isSecondaryIndexRecord(INDEX_INSERT)).toBe(true);
    expect(isSecondaryIndexRecord(INDEX_UPDATE)).toBe(true);
    expect(isSecondaryIndexRecord('SET')).toBe(false);

    expect(isVectorRecord(VECTOR_ADD)).toBe(true);
    expect(isVectorRecord(VECTOR_COMMIT_TXN)).toBe(true);
    expect(isVectorRecord('SET')).toBe(false);
  });
});

describe('WAL replay: index/vector markers are skipped; unknown actions warn', () => {
  async function writeOneSegment(line) {
    const dir = `${baseDir}-${Math.random().toString(36).slice(2)}`;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(dir), { recursive: true });
    await fs.writeFile(path.join(dir, '000000.wal'), `${line.trim()}\n`, 'utf8');
    return dir;
  }

  const noop = {
    onSet: () => {},
    onDelete: () => {},
    onRename: () => {},
    onSAdd: () => {},
    onSRem: () => {}
  };

  test('replay ignores vector and secondary-index marker actions', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const vLine = serializeEntry({
      action: VECTOR_ADD,
      target: 'VEC_x1',
      payload: [0.1, 0.2]
    });
    const vDir = await writeOneSegment(vLine);
    const vReader = new WALReader(vDir);
    await vReader.replay(0, noop);
    await fs.rm(vDir, { recursive: true, force: true }).catch(() => {});

    const iLine = serializeEntry({
      action: INDEX_INSERT,
      target: 'idx:field',
      bucket: 'leaf'
    });
    const iDir = await writeOneSegment(iLine);
    const iReader = new WALReader(iDir);
    await iReader.replay(0, noop);
    await fs.rm(iDir, { recursive: true, force: true }).catch(() => {});

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('replay warns once for an unknown action string', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const badLine = serializeEntry({ action: 'FAKE_unknown_v1_marker', hint: 1 });
    const dir = await writeOneSegment(badLine);
    const reader = new WALReader(dir);
    await reader.replay(0, noop);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    expect(warnSpy.mock.calls.some((c) =>
      String(c[0]).includes('FAKE_unknown_v1_marker')
    )).toBe(true);
    warnSpy.mockRestore();
  });
});
