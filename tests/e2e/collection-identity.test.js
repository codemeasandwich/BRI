/**
 * @file E2E tests for Bri collection storage identity safety.
 *
 * These scenarios use the public READY database surface because the invariant
 * protects external applications from durable prefix collisions, group-read
 * namespace overlap, and recovery-time ambiguity. Tests deliberately avoid
 * direct engine calls so refactors inside the schema registry or storage layer
 * do not invalidate the behavioral contract.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { openLocalDatabase } from '../helpers/open-database.js';
import JSS from '../../src/utils/jss/index.js';
import { BriRecoveryError, BriSchemaError } from '../../src/engine/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = './test-data-collection-identity';
const WAL_DIR = path.join(HERE, '..', '..', 'test-data-collection-identity-wal');
const WAL_CHILD = path.join(HERE, 'collection-identity-wal-child.mjs');

/**
 * Capture a thrown/rejected Bri error so assertions can inspect stable codes
 * and structured details instead of matching user-facing prose.
 *
 * @param {Function} fn - Sync or async operation expected to fail.
 * @returns {Promise<Error>} Captured error.
 */
async function captureError(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('Expected operation to throw');
}

/**
 * Open a quiet test database. Logger silence keeps identity assertions focused
 * on public behavior rather than the default standalone lifecycle logs.
 *
 * @param {string} dir - Data directory for this scenario.
 * @returns {Promise<Object>} READY database handle.
 */
async function openQuietDb(dir) {
  return openLocalDatabase({
    logger: false,
    storeConfig: {
      dataDir: dir,
      maxMemoryMB: 64
    }
  });
}

describe('Collection identity safety', () => {
  beforeEach(async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.rm(WAL_DIR, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.rm(WAL_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test('distinct storage identities support schema, writes, ID reads, and plural reads', async () => {
    const db = await openQuietDb(DATA_DIR);
    try {
      db.schema('alpha', { name: { type: String, required: true } });
      db.schema('bravo', { name: { type: String, required: true } });

      const alpha = await db.add.alpha({ name: 'A' });
      const bravo = await db.add.bravo({ name: 'B' });

      expect(alpha.$ID).toMatch(/^ALHA_/);
      expect(bravo.$ID).toMatch(/^BRVO_/);
      expect((await db.get.alpha(alpha.$ID)).name).toBe('A');
      expect((await db.get.bravo(bravo.$ID)).name).toBe('B');

      const alphaGroup = await db.get.alphaS();
      const bravoGroup = await db.get.bravoS();
      expect(alphaGroup.map((row) => row.$ID)).toEqual([alpha.$ID]);
      expect(bravoGroup.map((row) => row.$ID)).toEqual([bravo.$ID]);

      const identities = db.diag.collectionIdentities();
      expect(identities.find((row) => row.collection === 'alpha')).toMatchObject({
        storageIdentity: 'ALHA',
        unique: true,
        conflicts: []
      });
      expect(identities.find((row) => row.collection === 'bravo')).toMatchObject({
        storageIdentity: 'BRVO',
        unique: true,
        conflicts: []
      });
    } finally {
      await db.disconnect();
    }
  });

  test('diagnostics project conflicts before schema declaration without mutating storage', async () => {
    const db = await openQuietDb(DATA_DIR);
    try {
      const projected = db.diag.collectionIdentities(['alpha', 'alpineHa']);
      expect(projected).toEqual([
        {
          collection: 'alpha',
          storageIdentity: 'ALHA',
          prefix: 'ALHA',
          unique: false,
          conflicts: ['alpineHa']
        },
        {
          collection: 'alpineHa',
          storageIdentity: 'ALHA',
          prefix: 'ALHA',
          unique: false,
          conflicts: ['alpha']
        }
      ]);
      expect(db.diag.collectionIdentities()).toEqual([]);
    } finally {
      await db.disconnect();
    }
  });

  test('schema declaration rejects storage identity collisions deterministically', async () => {
    const db = await openQuietDb(DATA_DIR);
    try {
      db.schema('alpha', { name: { type: String, required: true } });
      const err = await captureError(() =>
        db.schema('alpineHa', { name: { type: String, required: true } })
      );

      expect(err).toBeInstanceOf(BriSchemaError);
      expect(err.code).toBe('COLLECTION_IDENTITY_COLLISION');
      expect(err.details).toMatchObject({
        storageIdentity: 'ALHA',
        prefix: 'ALHA'
      });
      expect(err.details.collections.sort()).toEqual(['alpha', 'alpineHa']);
    } finally {
      await db.disconnect();
    }
  });

  test('schema collision failure is independent of declaration order', async () => {
    const db = await openQuietDb(DATA_DIR);
    try {
      db.schema('alpineHa', { name: { type: String, required: true } });
      const err = await captureError(() =>
        db.schema('alpha', { name: { type: String, required: true } })
      );

      expect(err).toBeInstanceOf(BriSchemaError);
      expect(err.code).toBe('COLLECTION_IDENTITY_COLLISION');
      expect(err.details.collections.sort()).toEqual(['alpha', 'alpineHa']);
      expect(err.details.storageIdentity).toBe('ALHA');
    } finally {
      await db.disconnect();
    }
  });

  test('write paths reject a colliding collection before ambiguous rows persist', async () => {
    const db = await openQuietDb(DATA_DIR);
    try {
      const alpha = await db.add.alpha({ name: 'committed-alpha' });
      const err = await captureError(() =>
        db.add.alpineHa({ name: 'blocked-collision' })
      );

      expect(err).toBeInstanceOf(BriSchemaError);
      expect(err.code).toBe('COLLECTION_IDENTITY_COLLISION');
      await expect(db.get.alpineHaS()).rejects.toMatchObject({
        code: 'COLLECTION_IDENTITY_COLLISION'
      });

      const alphaRows = await db.get.alphaS();
      expect(alphaRows.map((row) => row.$ID)).toEqual([alpha.$ID]);
      expect(alphaRows[0].name).toBe('committed-alpha');
    } finally {
      await db.disconnect();
    }
  });

  test('snapshot recovery reloads identities and rejects later collisions', async () => {
    let db = await openQuietDb(DATA_DIR);
    const alpha = await db.add.alpha({ name: 'snapshot-alpha' });
    await db._store.createSnapshot();
    await db.disconnect();

    db = await openQuietDb(DATA_DIR);
    try {
      expect((await db.get.alpha(alpha.$ID)).name).toBe('snapshot-alpha');
      expect(db.diag.collectionIdentities()).toContainEqual(expect.objectContaining({
        collection: 'alpha',
        storageIdentity: 'ALHA',
        unique: true
      }));

      const err = await captureError(() =>
        db.schema('alpineHa', { name: { type: String, required: true } })
      );
      expect(err).toBeInstanceOf(BriSchemaError);
      expect(err.code).toBe('COLLECTION_IDENTITY_COLLISION');
    } finally {
      await db.disconnect();
    }
  });

  test('boot rejects ambiguous persisted identity catalogs before READY', async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, 'snapshot.jss'), JSS.stringify({
      version: 5,
      timestamp: new Date(),
      walLine: 0,
      documents: {},
      collections: {},
      collectionIdentities: {
        alpha: 'ALHA',
        alpineHa: 'ALHA'
      }
    }), 'utf8');

    const err = await captureError(() => openQuietDb(DATA_DIR));

    expect(err).toBeInstanceOf(BriRecoveryError);
    expect(err.code).toBe('COLLECTION_IDENTITY_COLLISION');
    expect(err.details).toMatchObject({
      storageIdentity: 'ALHA',
      prefix: 'ALHA'
    });
    expect(err.details.collections.sort()).toEqual(['alpha', 'alpineHa']);
  });

  test('WAL recovery reloads identities before accepting colliding schema declarations', async () => {
    const child = spawn('node', [WAL_CHILD, WAL_DIR], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('READY')) resolve();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`identity child failed: ${stderr}`));
      });
    });

    const db = await openQuietDb(WAL_DIR);
    try {
      expect(db.diag.collectionIdentities()).toContainEqual(expect.objectContaining({
        collection: 'alpha',
        storageIdentity: 'ALHA'
      }));
      await expect(
        Promise.resolve().then(() =>
          db.schema('alpineHa', { name: { type: String, required: true } })
        )
      ).rejects.toMatchObject({ code: 'COLLECTION_IDENTITY_COLLISION' });
    } finally {
      await db.disconnect();
    }
  });
});
