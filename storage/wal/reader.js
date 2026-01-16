/**
 * @file WAL Reader - Read and replay Write-Ahead Log
 *
 * Line format: {timestamp}|{pointer}|{entry}
 * Line position is the sequence number (no LSN needed).
 * Pointer chain verifies integrity.
 */

import fs from 'fs/promises';
import { createReadStream, readFileSync } from 'fs';
import readline from 'readline';
import { deserializeEntry, hashPointer, WALOp } from './entry.js';

/**
 * Reads and replays WAL entries for recovery
 */
export class WALReader {
  /**
   * Create a WAL reader
   * @param {string} walDir - WAL directory path
   * @param {Object} [options={}] - Configuration options
   * @param {Buffer} [options.encryptionKey=null] - 32-byte decryption key
   */
  constructor(walDir, options = {}) {
    this.walDir = walDir;
    this.encryptionKey = options.encryptionKey || null; // 32-byte key or null
  }

  /**
   * Get all WAL segment file paths
   * @returns {Promise<string[]>} Sorted array of segment paths
   */
  async getSegments() {
    const files = await fs.readdir(this.walDir).catch(() => []);
    return files
      .filter(f => f.endsWith('.wal'))
      .sort()
      .map(f => `${this.walDir}/${f}`);
  }

  async *readEntries(afterLine = 0) {
    const segments = await this.getSegments();
    let lineNumber = 0;

    for (const segmentPath of segments) {
      const stream = createReadStream(segmentPath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
      });

      // Use event-based approach for Bun compatibility
      const entries = await new Promise((resolve, reject) => {
        const results = [];
        rl.on('line', (line) => {
          lineNumber++;
          if (!line || !line.trim()) return;
          if (lineNumber <= afterLine) return;
          try {
            const entry = deserializeEntry(line, this.encryptionKey);
            entry._line = lineNumber;
            results.push(entry);
          } catch (err) {
            console.warn(`WAL: Skipping corrupted entry at line ${lineNumber}: ${err.message}`);
          }
        });
        rl.on('close', () => resolve(results));
        rl.on('error', reject);
      });

      for (const entry of entries) {
        yield entry;
      }
    }
  }

  /**
   * Replay WAL entries through handlers
   * @param {number} afterLine - Start replaying after this line number
   * @param {Object} handlers - Operation handlers
   * @param {Function} handlers.onSet - Called for SET operations
   * @param {Function} handlers.onDelete - Called for DELETE operations
   * @param {Function} handlers.onRename - Called for RENAME operations
   * @param {Function} handlers.onSAdd - Called for SADD operations
   * @param {Function} handlers.onSRem - Called for SREM operations
   * @returns {Promise<number>} Last replayed line number
   */
  async replay(afterLine, handlers) {
    let count = 0;
    let lastLine = afterLine;

    for await (const entry of this.readEntries(afterLine)) {
      switch (entry.action) {
        case WALOp.SET:
          handlers.onSet(entry.target, entry.value);
          break;
        case WALOp.DELETE:
          handlers.onDelete(entry.target);
          break;
        case WALOp.RENAME:
          handlers.onRename(entry.oldKey, entry.target);
          break;
        case WALOp.SADD:
          handlers.onSAdd(entry.target, entry.member);
          break;
        case WALOp.SREM:
          handlers.onSRem(entry.target, entry.member);
          break;
        default:
          console.warn(`WAL: Unknown action: ${entry.action}`);
      }

      lastLine = entry._line;
      count++;
    }

    if (count > 0) {
      console.log(`WAL: Replayed ${count} entries`);
    }

    return lastLine;
  }

  /**
   * Get total line count across all segments
   * @returns {Promise<number>} Total line count
   */
  async getLineCount() {
    let count = 0;
    for await (const entry of this.readEntries(0)) {
      count = entry._line;
    }
    return count;
  }

  /**
   * Verify pointer chain integrity across all WAL segments
   * @returns {Promise<{valid: boolean, totalLines: number, errors: Array}>} Integrity result
   */
  async verifyIntegrity() {
    const segments = await this.getSegments();
    let prevPointer = null;
    let lineNumber = 0;
    const errors = [];

    for (const segmentPath of segments) {
      try {
        const content = readFileSync(segmentPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          lineNumber++;
          try {
            const entry = deserializeEntry(line, this.encryptionKey);

            // Verify pointer = hash(prevPointer, entryJson)
            const expectedPointer = hashPointer(prevPointer, entry._entryJson);
            if (entry._pointer !== expectedPointer) {
              errors.push({
                line: lineNumber,
                error: 'Pointer mismatch',
                expected: expectedPointer,
                got: entry._pointer
              });
            }

            prevPointer = entry._pointer;
          } catch (err) {
            errors.push({ line: lineNumber, error: `Parse error: ${err.message}` });
          }
        }
      } catch (err) {
        errors.push({ segment: segmentPath, error: `Read error: ${err.message}` });
      }
    }

    return {
      valid: errors.length === 0,
      totalLines: lineNumber,
      errors
    };
  }
}
