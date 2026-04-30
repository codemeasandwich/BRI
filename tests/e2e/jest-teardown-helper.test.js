/**
 * @file Verifies {@link removeRepoRootTestArtifact}: single-directory removal matches the
 * selective half of Jest global teardown so bad basenames cannot traverse outside the repo root.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { removeRepoRootTestArtifact } from '../jest/global-teardown.js';

describe('removeRepoRootTestArtifact (Jest teardown helper)', () => {
  test('deletes a single repo-root dir whose name matches test-data-*', async () => {
    const root = process.cwd();
    const dirname = `test-data-jest-teardown-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const dir = path.join(root, dirname);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'sentinel.txt'), 'x', 'utf8');

    await removeRepoRootTestArtifact(root, dirname);

    await expect(fs.stat(dir)).rejects.toMatchObject(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });
});
