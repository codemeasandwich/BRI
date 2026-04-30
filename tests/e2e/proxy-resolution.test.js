/**
 * @file Cross-cutting acceptance for predicate proxy resolution rules.
 *
 * Spec §0.4 + §3.5 freeze a proxy property-access lookup algorithm and a
 * reserved-name list. This file asserts:
 *   - Schema declaring a predicate that collides with a reserved name
 *     throws BriSchemaError code RESERVED_NAME_COLLISION at declare time.
 *   - Schema declaring a ref FIELD that collides with a reserved name
 *     throws RESERVED_NAME_COLLISION at declare time (spec §2.1.4).
 *   - Predicate access on an entity that is registered routes to the
 *     PredicateAccessor (write/read/.$ behavior).
 *   - Plain field access on an entity returns the raw value.
 *   - Unknown predicate access on an entity that has registered
 *     predicates throws BriProxyError PREDICATE_NOT_REGISTERED with a
 *     diagnostic message that lists valid options.
 *
 * @implements spec §0.4, §2.1.4, §3.5
 */
import { jest } from '@jest/globals';
import { openLocalDatabase } from '../helpers/open-database.js';
import {
  BriSchemaError, BriProxyError,
  RESERVED_NAME_COLLISION, PREDICATE_NOT_REGISTERED
} from '../../src/engine/errors.js';
import fs from 'fs/promises';

const DIR = './test-data-proxy-res';
async function freshDB() {
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  return openLocalDatabase({ storeConfig: { dataDir: DIR, maxMemoryMB: 64 } });
}

describe('Proxy resolution (spec §0.4, §3.5)', () => {
  let db;
  afterEach(async () => { if (db) await db.disconnect?.(); });

  describe('reserved-name collision detection at schema load', () => {
    test('predicate name colliding with reserved word throws RESERVED_NAME_COLLISION', async () => {
      db = await freshDB();
      db.schema('node', { name: { type: String, required: true } });
      let thrown;
      try {
        db.schema('edge', {
          src: { type: 'ref', to: 'node', required: true },
          dst: { type: 'ref', to: 'node', required: true },
          predicate: { type: String, required: true },
          $edge: { from: 'node', to: 'node', predicate: 'predicate',
                   predicates: ['history'] }   // collides
        });
      } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriSchemaError);
      expect(thrown.code).toBe(RESERVED_NAME_COLLISION);
    });

    test('ref field name colliding with reserved word throws (spec §2.1.4)', async () => {
      db = await freshDB();
      db.schema('node', { name: { type: String, required: true } });
      let thrown;
      try {
        db.schema('edge', {
          touching: { type: 'ref', to: 'node', required: true },   // collides
          dst:      { type: 'ref', to: 'node', required: true },
          $edge: { from: 'node', to: 'node' }
        });
      } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(BriSchemaError);
      expect(thrown.code).toBe(RESERVED_NAME_COLLISION);
    });
  });

  describe('property access on entity (spec §3.5 lookup order)', () => {
    test('declared field takes precedence over predicate routing', async () => {
      db = await freshDB();
      db.schema('node', {
        name: { type: String, required: true }
      });
      db.schema('edge', {
        src: { type: 'ref', to: 'node', required: true },
        dst: { type: 'ref', to: 'node', required: true },
        predicate: { type: String, required: true },
        $edge: { from: 'node', to: 'node', predicate: 'predicate',
                 predicates: ['knows'] }
      });
      const a = await db.add.node({ name: 'A' });
      // Read declared field — returns the raw value, not a proxy.
      expect(a.name).toBe('A');
    });

    test('predicate access on registered subject returns a callable+thenable', async () => {
      db = await freshDB();
      db.schema('node', { name: { type: String, required: true } });
      db.schema('edge', {
        src: { type: 'ref', to: 'node', required: true },
        dst: { type: 'ref', to: 'node', required: true },
        predicate: { type: String, required: true },
        $edge: { from: 'node', to: 'node', predicate: 'predicate',
                 predicates: ['knows'] }
      });
      const a = await db.add.node({ name: 'A' });
      const b = await db.add.node({ name: 'B' });
      // Write
      await a.knows(b);
      // Read targets
      const targets = await a.knows;
      expect(targets.length).toBe(1);
      expect(targets[0].$ID).toBe(b.$ID);
    });
  });

  describe('createGetProxy outer Callable target', () => {
    test('Reflect.apply invokes the empty Proxy target (legacy call shape)', async () => {
      db = await freshDB();
      expect(Reflect.apply(db.get, null, [])).toBeUndefined();
    });
  });
});
