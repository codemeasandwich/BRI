/**
 * Cold Tier File Storage
 *
 * Structure: /data/cold/{TYPE}/{id}.jss
 * - TYPE extracted from $ID (e.g., POST_fu352dp → POST)
 * - Uses JSS (JsonSuperSet) for proper type serialization
 * - ONLY stores documents evicted due to memory pressure
 * - No sets storage (sets are always in-memory)
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import JSS from '../../utils/jss/index.js';

export class ColdTierFiles {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.coldDir = path.join(dataDir, 'cold');

    if (!existsSync(this.coldDir)) {
      mkdirSync(this.coldDir, { recursive: true });
    }
  }

  // Extract TYPE from key (e.g., "POST_fu352dp" → "POST", "X:POST_fu352dp:X" → "POST")
  extractType(key) {
    // Handle soft-deleted keys like "X:POST_fu352dp:X"
    const cleanKey = key.replace(/^X:|:X$/g, '');
    const underscoreIdx = cleanKey.indexOf('_');
    if (underscoreIdx > 0) {
      return cleanKey.slice(0, underscoreIdx);
    }
    return cleanKey;
  }

  // Extract ID from key (e.g., "POST_fu352dp" → "fu352dp")
  extractId(key) {
    const cleanKey = key.replace(/^X:|:X$/g, '');
    const underscoreIdx = cleanKey.indexOf('_');
    if (underscoreIdx > 0) {
      return cleanKey.slice(underscoreIdx + 1);
    }
    return cleanKey;
  }

  getDocPath(key) {
    const type = this.extractType(key);
    const id = this.extractId(key);
    const typeDir = path.join(this.coldDir, type);

    if (!existsSync(typeDir)) {
      mkdirSync(typeDir, { recursive: true });
    }

    return path.join(typeDir, `${id}.jss`);
  }

  async writeDoc(key, value) {
    const filePath = this.getDocPath(key);
    const tempPath = filePath + '.tmp';

    // Value is already JSON string from store, parse and re-encode as JSS
    let data;
    try {
      data = JSON.parse(value);
    } catch {
      data = value;
    }

    await fs.writeFile(tempPath, JSS.stringify(data), 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async readDoc(key) {
    const filePath = this.getDocPath(key);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSS.parse(content);
      return JSON.stringify(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async deleteDoc(key) {
    const filePath = this.getDocPath(key);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async docExists(key) {
    const filePath = this.getDocPath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listDocs() {
    const docs = [];

    try {
      const types = await fs.readdir(this.coldDir);

      for (const type of types) {
        const typeDir = path.join(this.coldDir, type);
        const stat = await fs.stat(typeDir);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(typeDir);
        for (const file of files) {
          if (file.endsWith('.jss')) {
            const id = file.slice(0, -4);
            docs.push(`${type}_${id}`);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    return docs;
  }

  async getStats() {
    const docFiles = await this.listDocs();

    let totalSize = 0;
    for (const key of docFiles) {
      try {
        const stat = await fs.stat(this.getDocPath(key));
        totalSize += stat.size;
      } catch {}
    }

    return {
      coldDocuments: docFiles.length,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100
    };
  }
}
