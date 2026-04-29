/**
 * Generates README.md and files.md under test-data-* directories so
 * .hooks/pre-commit.d/check-docs.sh passes. Run after adding hermetic fixtures:
 *   node scripts/sync-test-data-docs.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: 'utf8' }).trim();
}

const staged = git('git diff --cached --name-only').split('\n').filter(Boolean);
const skipRoot = /^(node_modules|coverage|\.git|\.hooks|\.github|example|todo|scripts)\//;

function dirInHead(d) {
  try {
    execSync(`git ls-tree -d HEAD -- "${d}"`, { cwd: REPO, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Collect dirs that need README/files.md (new to git) + dirs that hold staged assets */
const newDirs = new Set();
const dirsWithAssets = new Set();

for (const f of staged) {
  if (skipRoot.test(f)) continue;
  if (!f.startsWith('test-data')) continue;
  const base = path.basename(f);
  if (base === 'README.md' || base === 'files.md') continue;
  if (f.endsWith('.test.js')) continue;

  let d = path.dirname(f);
  while (d && d !== '.') {
    if (!d.startsWith('test-data')) break;
    dirsWithAssets.add(d);
    if (!dirInHead(d)) newDirs.add(d);
    d = path.dirname(d);
  }
}

function sortedEntries(dir) {
  let names = fs.readdirSync(dir);
  names.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a));
    const sb = fs.statSync(path.join(dir, b));
    const da = sa.isDirectory();
    const db = sb.isDirectory();
    if (da !== db) return da ? -1 : 1;
    return a.localeCompare(b);
  });
  return names.filter((n) => n !== 'files.md');
}

function writeFilesMd(dirabs) {
  const label = path.basename(dirabs);
  const names = sortedEntries(dirabs);
  const lines = [];
  lines.push('## Directory Structure');
  lines.push('');
  lines.push('```');
  lines.push(`${label}/`);
  names.forEach((n, i) => {
    const isLast = i === names.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const full = path.join(dirabs, n);
    const isDir = fs.statSync(full).isDirectory();
    lines.push(branch + (isDir ? `${n}/` : n));
  });
  lines.push('```');
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const n of names) {
    const full = path.join(dirabs, n);
    const isDir = fs.statSync(full).isDirectory();
    const header = isDir ? `### \`${n}/\`` : `### \`${n}\``;
    lines.push(header);
    lines.push('');
    if (isDir) {
      lines.push(`Hermetic subdirectory — see ${n}/files.md.`);
    } else if (n.endsWith('.wal')) {
      lines.push('WAL segment fixture for integration/E2E tests.');
    } else if (n.endsWith('.jss')) {
      lines.push('Snapshot fixture for integration/E2E tests.');
    } else {
      lines.push('Fixture file for integration/E2E tests.');
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(dirabs, 'files.md'), lines.join('\n').trim() + '\n', 'utf8');
}

function writeReadme(dirabs) {
  const title = path.basename(dirabs);
  const body = `# ${title}\n\nHermetic test fixture directory (see files.md).\n`;
  fs.writeFileSync(path.join(dirabs, 'README.md'), body, 'utf8');
}

const allDocDirs = new Set([...newDirs, ...dirsWithAssets]);
for (const d of [...allDocDirs].sort()) {
  const dirabs = path.join(REPO, d);
  if (!fs.existsSync(dirabs) || !fs.statSync(dirabs).isDirectory()) continue;
  if (/^(node_modules|coverage|\.git|\.hooks|\.github|example|todo|scripts)(\/|$)/.test(d)) {
    continue;
  }
  writeFilesMd(dirabs);
  if (newDirs.has(d)) writeReadme(dirabs);
}

console.error(`Updated docs under ${allDocDirs.size} directories (sync-test-data-docs).`);
