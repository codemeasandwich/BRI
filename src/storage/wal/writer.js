/**
 * @file WAL Writer - Append-only Write-Ahead Log
 *
 * Line format: {timestamp}|{pointer}|{entry}
 * Pointer = hash(prevPointer, entry) for chain integrity
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { serializeEntry, serializeEntryEncrypted, deserializeEntry } from './entry.js';

/**
 * Writes WAL entries with pointer chain integrity
 */
export class WALWriter {
  /**
   * Create a WAL writer
   * @param {string} walDir - WAL directory path
   * @param {Object} [options={}] - Configuration options
   * @param {string} [options.fsyncMode='batched'] - Sync mode: 'always' or 'batched'
   * @param {number} [options.fsyncIntervalMs=100] - Batched sync interval
   * @param {number} [options.segmentSize=10485760] - Segment size in bytes
   * @param {Buffer} [options.encryptionKey=null] - 32-byte encryption key
   */
  constructor(walDir, options = {}) {
    this.walDir = walDir;
    this.fsyncMode = options.fsyncMode || 'batched';
    this.fsyncIntervalMs = options.fsyncIntervalMs || 100;
    this.segmentSize = options.segmentSize || 10 * 1024 * 1024;
    this.encryptionKey = options.encryptionKey || null; // 32-byte key or null

    this.currentSegment = 0;
    this.currentSize = 0;
    this.fileHandle = null;
    this.fsyncTimer = null;
    // Close state lets the batched fsync timer distinguish expected shutdown
    // races from real durability errors that should still be reported.
    this.isClosing = false;
    this.lastPointer = null;
    this.writeQueue = Promise.resolve(); // Serialize writes for pointer chain integrity

    if (!existsSync(walDir)) {
      mkdirSync(walDir, { recursive: true });
    }
  }

  /**
   * Initialize the writer and open current segment
   * @returns {Promise<void>}
   */
  async init() {
    const files = await fs.readdir(this.walDir).catch(() => []);
    const segments = files
      .filter(f => f.endsWith('.wal'))
      .map(f => parseInt(f.split('.')[0], 10))
      .filter(n => !isNaN(n));

    this.currentSegment = segments.length > 0 ? Math.max(...segments) : 0;
    await this.openSegment();

    // Get pointer from last line for chain continuity
    this.lastPointer = await this.getLastPointer();

    if (this.fsyncMode === 'batched') {
      this.startFsyncTimer();
    }
  }

  /**
   * Open a WAL segment for writing
   * @returns {Promise<void>}
   */
  async openSegment() {
    const segmentPath = this.getSegmentPath(this.currentSegment);

    if (this.fileHandle) {
      // Detach the shared handle before awaiting close so the fsync timer cannot
      // race against a handle that is already in the process of closing.
      const handle = this.fileHandle;
      this.fileHandle = null;
      await handle.close();
    }

    this.fileHandle = await fs.open(segmentPath, 'a');
    const stats = await this.fileHandle.stat();
    this.currentSize = stats.size;
  }

  /**
   * Get pointer from last line across all segments for chain continuity
   * @returns {Promise<string|null>} Last pointer or null if no entries
   */
  async getLastPointer() {
    const segments = await this.getSegments();
    if (segments.length === 0) return null;

    // Read last segment and get last line's pointer
    for (let i = segments.length - 1; i >= 0; i--) {
      try {
        const content = readFileSync(segments[i], 'utf8');
        const lines = content.trim().split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          const entry = deserializeEntry(lastLine, this.encryptionKey);
          return entry._pointer;
        }
      } catch (err) {
        continue;
      }
    }
    return null;
  }

  /**
   * Get path for a segment number
   * @param {number} segmentNum - Segment number
   * @returns {string} Full path to segment file
   */
  getSegmentPath(segmentNum) {
    const padded = String(segmentNum).padStart(6, '0');
    return path.join(this.walDir, `${padded}.wal`);
  }

  /**
   * Append an entry to the WAL
   * @param {Object} entry - Entry to append
   * @returns {Promise<void>}
   */
  append(entry) {
    // Queue writes to maintain pointer chain integrity
    this.writeQueue = this.writeQueue.then(() => this._doAppend(entry));
    return this.writeQueue;
  }

  /**
   * Internal append implementation
   * @param {Object} entry - Entry to append
   * @returns {Promise<void>}
   * @private
   */
  async _doAppend(entry) {
    // Serialize: {timestamp}|{pointer}|{entry}
    // pointer = hash(lastPointer, entryJson)
    // If encryption enabled, entry portion is encrypted with AAD = timestamp|pointer
    const line = this.encryptionKey
      ? serializeEntryEncrypted(entry, this.encryptionKey, this.lastPointer)
      : serializeEntry(entry, this.lastPointer);
    const lineWithNewline = line + '\n';
    const bytes = Buffer.byteLength(lineWithNewline, 'utf8');

    if (this.currentSize + bytes > this.segmentSize) {
      await this.rotate();
    }

    await this.fileHandle.write(lineWithNewline);
    this.currentSize += bytes;

    // Extract pointer from the line we just wrote for next entry
    const parts = line.split('|');
    this.lastPointer = parts[1];

    if (this.fsyncMode === 'always') {
      await this.fileHandle.sync();
    }
  }

  /**
   * Rotate to a new segment
   * @returns {Promise<void>}
   */
  async rotate() {
    if (this.fileHandle) {
      // Segment rotation hands ownership of the current descriptor to this block
      // before sync/close, preventing the periodic fsync loop from reusing it.
      const handle = this.fileHandle;
      this.fileHandle = null;
      await handle.sync();
      await handle.close();
    }
    this.currentSegment++;
    await this.openSegment();
  }

  /**
   * Start batched fsync timer
   */
  startFsyncTimer() {
    this.fsyncTimer = setInterval(async () => {
      // Capture the descriptor once per tick.  A concurrent close/rotate/archive
      // may clear `fileHandle`; the captured handle is either still valid or the
      // EBADF below is the expected result of the shutdown race.
      const handle = this.fileHandle;
      if (handle && !this.isClosing) {
        try {
          await handle.sync();
        } catch (err) {
          if (this.isClosing || err?.code === 'EBADF') return;
          console.error('WAL fsync error:', err);
        }
      }
    }, this.fsyncIntervalMs);
    // Unref so this timer never holds the event loop open on its own.
    // Periodic firing is unaffected — only process-exit semantics change.
    // Without this, Jest runs trigger "worker failed to exit gracefully"
    // when a test forgets to call disconnect() and the fsync timer keeps the
    // process alive past test completion.
    this.fsyncTimer.unref?.();
  }

  /**
   * Force sync to disk
   * @returns {Promise<void>}
   */
  async sync() {
    if (this.fileHandle) {
      await this.fileHandle.sync();
    }
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
      .map(f => path.join(this.walDir, f));
  }

  /**
   * Archive current segment and start a new one
   * @returns {Promise<number>} Archived segment number
   */
  async archive() {
    await this.sync();

    if (this.fileHandle) {
      // Archive closes the active descriptor before opening the next segment, so
      // the shared handle must be cleared before the asynchronous close begins.
      const handle = this.fileHandle;
      this.fileHandle = null;
      await handle.close();
    }

    const archivedSegment = this.currentSegment;

    // Start fresh segment
    this.currentSegment++;
    this.currentSize = 0;
    await this.openSegment();

    return archivedSegment;
  }

  /**
   * Close the writer and cleanup
   * @returns {Promise<void>}
   */
  async close() {
    // Mark shutdown first so any in-flight fsync timer tick can suppress EBADF
    // from a descriptor that close() is legitimately tearing down.
    this.isClosing = true;
    if (this.fsyncTimer) {
      clearInterval(this.fsyncTimer);
      this.fsyncTimer = null;
    }

    if (this.fileHandle) {
      // Own the descriptor locally while flushing and closing.  Consumers may
      // call close() during test teardown while the timer has just fired, so
      // EBADF is tolerated only on this close path.
      const handle = this.fileHandle;
      this.fileHandle = null;
      await handle.sync().catch((err) => {
        if (err?.code !== 'EBADF') throw err;
      });
      await handle.close().catch((err) => {
        if (err?.code !== 'EBADF') throw err;
      });
    }
  }
}
