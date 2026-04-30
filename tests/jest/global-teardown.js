/**
 * @file Jest global teardown — wipe repository-root `test-data-*` directories after all
 * suites finish so integration runs leave no stale WAL/snapshot debris.
 *
 * Domain context: E2E tests default to `./test-data-<suite>` beside `package.json`; those trees
 * are disposable artifacts only. Contributors store long-lived fixtures under `tests/fixtures/`,
 * never under `test-data-*`.
 *
 * Technical context: Runs once in the Jest orchestrator process after workers exit
 * (`globalTeardown` contract). Entries are enumerated with `withFileTypes: true`; only real
 * directories whose names match /^test-data-/ are removed — symlinks are skipped to avoid
 * following user-defined links outside the repo. `rm` failures are swallowed so teardown never
 * flips a green run red over filesystem quirks.
 *
 * Mid-run tests must call {@link removeRepoRootTestArtifact} for a single basename only;
 * {@link removeRepoRootTestDataDirs} removes **all** matching roots and must run only from
 * this module's default export hook so parallel suites are not disrupted.
 */

import fs from 'fs/promises';
import path from 'path';

/** Names of integration artifact roots at the repository root (only directories). */
const TEST_DATA_DIR_PREFIX = /^test-data-/;

/**
 * Deletes `path.join(repoRoot, baseName)` when `baseName` matches the integration artifact
 * prefix and the target is a non-symlink directory. Intended for narrowly scoped tests;
 * rejects path segments so callers cannot wipe arbitrary paths.
 *
 * @param {string} repoRoot
 * @param {string} baseName — immediate child name only (e.g. `test-data-teardown-xyz`)
 * @returns {Promise<void>}
 */
export async function removeRepoRootTestArtifact(repoRoot, baseName) {
  try {
    if (baseName !== path.basename(baseName)) return;
    if (!TEST_DATA_DIR_PREFIX.test(baseName)) return;
    const full = path.join(repoRoot, baseName);
    if (full !== path.normalize(full)) return;
    const st = await fs.lstat(full).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
    await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  } catch {
    /* ignore — teardown must not fail the run */
  }
}

/**
 * Delete every immediate child directory of `repoRoot` whose name starts with `test-data-`.
 *
 * @param {string} repoRoot — usually `process.cwd()` when Jest runs from the package root
 * @returns {Promise<void>}
 */
export async function removeRepoRootTestDataDirs(repoRoot) {
  const entries = await fs.readdir(repoRoot, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      removeRepoRootTestArtifact(repoRoot, entry.name).catch(() => {})
    )
  );
}

/**
 * Jest invokes this hook after all tests complete across workers.
 *
 * @returns {Promise<void>}
 */
export default async function globalTeardown() {
  await removeRepoRootTestDataDirs(process.cwd());
}
