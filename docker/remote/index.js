/**
 * @file BRI Remote Client - Complete API Examples via WebSocket
 *
 * This file demonstrates EVERY possible way clients can interface with BRI
 * through a remote WebSocket connection using apiDB().
 *
 * Run with: bun docker/remote/index.js
 * (Requires server running: bun docker/server/index.js)
 */

import { apiDB } from '../../index.js';
import { printBanner, printComplete, printCleanup } from './helpers.js';
import { runCrudExamples } from './01-crud.js';
import { runArrayUpdateExamples } from './02-arrays-update.js';
import { runDeleteRelationExamples } from './03-delete-relations.js';
import { runPopulateSubsExamples } from './04-populate-subs.js';
import { runTransactionExamples } from './05-transactions.js';
import { runAdvancedExamples } from './06-advanced.js';

/**
 * Main entry point for remote client examples
 * @returns {Promise<void>}
 */
async function main() {
  printBanner();

  const db = await apiDB();

  // Run all example modules
  const entities = await runCrudExamples(db);
  await runArrayUpdateExamples(db, entities);
  const relEntities = await runDeleteRelationExamples(db, entities);
  await runPopulateSubsExamples(db, relEntities);
  await runTransactionExamples(db);
  await runAdvancedExamples(db, entities);

  // Cleanup
  printCleanup();
  await db.disconnect();
  console.log('  Database disconnected');

  printComplete();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
