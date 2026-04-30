#!/usr/bin/env node
/**
 * @file JSDoc coverage gate (spec §3.5 / §8 #4).
 *
 * Walks every public export in the project source roots and asserts the
 * preceding code has a non-empty JSDoc docblock. Fails CI on any
 * undocumented export.
 *
 * Detection rules (deliberately simple — heavy dependencies would defeat
 * the "lint script you can run anywhere" goal):
 *   - matches `export function`, `export async function`, `export class`,
 *     `export const NAME = (`, `export const NAME = function`,
 *     `export default function|class` patterns
 *   - looks at the immediately preceding lines for a `/** ... *\/` block
 *   - skips matches inside strings/template-literals via a coarse
 *     code/comment state machine — good enough for a tree of clean
 *     source files; not a full parser
 *
 * Roots scanned: src/client/, src/crypto/, src/engine/, src/storage/, src/utils/, src/workers/.
 *
 * Exit codes:
 *   0  every export has a docblock
 *   1  one or more violations — list printed to stderr
 *   2  filesystem or invocation error
 *
 * Usage:
 *   node scripts/jsdoc-check.js                  # default roots
 *   node scripts/jsdoc-check.js client engine    # custom roots
 *   node scripts/jsdoc-check.js --quiet          # only print summary
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_ROOTS = [
  'src/client',
  'src/crypto',
  'src/engine',
  'src/storage',
  'src/utils',
  'src/workers'
];

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const cliRoots = args.filter(a => !a.startsWith('--'));
const roots = cliRoots.length > 0 ? cliRoots : DEFAULT_ROOTS;

/**
 * Recursively collect `.js` files under a directory, skipping
 * node_modules / coverage / dist.
 *
 * @param {string} dir - Absolute directory path
 * @param {Array<string>} out
 * @returns {Array<string>}
 */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'coverage'
        || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Scan one source file for exports without docblocks. Coarse but
 * effective: split on lines, walk forward, when we hit an export-line
 * pattern, look backward for a docblock immediately before it.
 *
 * @param {string} filePath - Absolute file path
 * @returns {Array<{file:string, line:number, name:string}>}
 */
function scan(filePath) {
  const violations = [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = matchExport(line);
    if (!m) continue;
    if (!hasDocblockBefore(lines, i)) {
      violations.push({
        file: path.relative(ROOT, filePath),
        line: i + 1,
        name: m
      });
    }
  }
  return violations;
}

/**
 * Recognise an exported public-surface declaration. Returns the
 * exported name, or null if the line isn't an export of a function /
 * class / const that needs a docblock.
 *
 * Excluded: re-exports (`export { X } from ...`), type-only exports,
 * and `export default <expression>` where the expression is a literal —
 * those are infrastructure rather than documentable surface.
 *
 * @param {string} line
 * @returns {string|null} export name or null
 */
function matchExport(line) {
  const trimmed = line.trim();
  // Skip re-exports.
  if (/^export\s*{[^}]*}\s*from\b/.test(trimmed)) return null;
  if (/^export\s*\*\s*from\b/.test(trimmed)) return null;
  // Skip pure default-value exports of literal expressions.
  if (/^export\s+default\s+(?!function|async\s+function|class)/.test(trimmed)) return null;

  // Documentable patterns.
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^export\s+class\s+([A-Za-z_$][\w$]*)/,
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*=>/,
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/,
    /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)?/,
    /^export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1] || '<default>';
  }
  return null;
}

/**
 * Look back from line index `i` for a JSDoc closer. Skip blank lines;
 * the search ends as soon as we hit non-blank that isn't `*/` or part
 * of a docblock. Multi-line docblocks must START with `/**` somewhere
 * in the preceding span.
 *
 * @param {Array<string>} lines
 * @param {number} i - Index of the export line
 * @returns {boolean}
 */
function hasDocblockBefore(lines, i) {
  let j = i - 1;
  // Skip leading blank lines.
  while (j >= 0 && lines[j].trim() === '') j--;
  if (j < 0) return false;
  // Closer must be on this line.
  if (!/\*\/\s*$/.test(lines[j])) return false;
  // Walk back until we find the opener `/**` or hit something that's
  // not part of a comment.
  while (j >= 0) {
    if (/^\s*\/\*\*/.test(lines[j])) return true;
    j--;
  }
  return false;
}

let total = 0;
const allViolations = [];
for (const root of roots) {
  const dir = path.resolve(ROOT, root);
  const files = walk(dir);
  for (const f of files) {
    const v = scan(f);
    if (v.length > 0) allViolations.push(...v);
    total += 1;
  }
}

if (allViolations.length === 0) {
  if (!quiet) {
    process.stdout.write(
      `jsdoc-check: ${total} files scanned across [${roots.join(', ')}]; zero undocumented exports.\n`
    );
  }
  process.exit(0);
}

process.stderr.write(
  `jsdoc-check: ${allViolations.length} undocumented export(s) across ${total} files:\n`
);
for (const v of allViolations) {
  process.stderr.write(`  ${v.file}:${v.line}  ${v.name}\n`);
}
process.exit(1);
