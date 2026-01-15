/**
 * WAL Writer - Append-only Write-Ahead Log
 *
 * Line format: {timestamp}|{pointer}|{entry}
 * Pointer = hash(prevPointer, entry) for chain integrity
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { serializeEntry, deserializeEntry } from './entry.js';

export class WALWriter {
  constructor(walDir, options = {}) {
    this.walDir = walDir;
    this.fsyncMode = options.fsyncMode || 'batched';
    this.fsyncIntervalMs = options.fsyncIntervalMs || 100;
    this.segmentSize = options.segmentSize || 10 * 1024 * 1024;

    this.currentSegment = 0;
    this.currentSize = 0;
    this.fileHandle = null;
    this.fsyncTimer = null;
    this.lastPointer = null;
    this.writeQueue = Promise.resolve(); // Serialize writes for pointer chain integrity

    if (!existsSync(walDir)) {
      mkdirSync(walDir, { recursive: true });
    }
  }

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

  async openSegment() {
    const segmentPath = this.getSegmentPath(this.currentSegment);

    if (this.fileHandle) {
      await this.fileHandle.close();
    }

    this.fileHandle = await fs.open(segmentPath, 'a');
    const stats = await fs.stat(segmentPath).catch(() => ({ size: 0 }));
    this.currentSize = stats.size;
  }

  // Get pointer from last line across all segments for chain continuity
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
          const entry = deserializeEntry(lastLine);
          return entry._pointer;
        }
      } catch (err) {
        continue;
      }
    }
    return null;
  }

  getSegmentPath(segmentNum) {
    const padded = String(segmentNum).padStart(6, '0');
    return path.join(this.walDir, `${padded}.wal`);
  }

  append(entry) {
    // Queue writes to maintain pointer chain integrity
    this.writeQueue = this.writeQueue.then(() => this._doAppend(entry));
    return this.writeQueue;
  }

  async _doAppend(entry) {
    // Serialize: {timestamp}|{pointer}|{entry}
    // pointer = hash(lastPointer, entryJson)
    const line = serializeEntry(entry, this.lastPointer);
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

  async rotate() {
    if (this.fileHandle) {
      await this.fileHandle.sync();
      await this.fileHandle.close();
    }
    this.currentSegment++;
    await this.openSegment();
  }

  startFsyncTimer() {
    this.fsyncTimer = setInterval(async () => {
      if (this.fileHandle) {
        try {
          await this.fileHandle.sync();
        } catch (err) {
          console.error('WAL fsync error:', err);
        }
      }
    }, this.fsyncIntervalMs);
  }

  async sync() {
    if (this.fileHandle) {
      await this.fileHandle.sync();
    }
  }

  async getSegments() {
    const files = await fs.readdir(this.walDir).catch(() => []);
    return files
      .filter(f => f.endsWith('.wal'))
      .sort()
      .map(f => path.join(this.walDir, f));
  }

  async archive() {
    await this.sync();

    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }

    const archivedSegment = this.currentSegment;

    // Start fresh segment
    this.currentSegment++;
    this.currentSize = 0;
    await this.openSegment();

    return archivedSegment;
  }

  async close() {
    if (this.fsyncTimer) {
      clearInterval(this.fsyncTimer);
      this.fsyncTimer = null;
    }

    if (this.fileHandle) {
      await this.fileHandle.sync();
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }
}
