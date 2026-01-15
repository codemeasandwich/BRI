/**
 * @file Hot Tier Cache - In-memory LRU cache with cold eviction
 */

import { createSnapshotMethods } from './cache-snapshot.js';
import { createEvictionMethods } from './cache-eviction.js';

/**
 * In-memory LRU cache with hot/cold tier management
 */
export class HotTierCache {
  /**
   * Creates a new HotTierCache instance
   * @param {Object} options - Configuration options
   * @param {number} options.maxMemoryMB - Maximum memory in megabytes (required)
   * @param {number} options.evictionThreshold - Memory threshold for eviction (default 0.8)
   * @param {Function} options.onEvict - Callback when evicting to cold storage
   * @param {Function} options.coldLoader - Function to load items from cold storage
   */
  constructor(options) {
    if (!options.maxMemoryMB) {
      throw new Error('maxMemoryMB is required');
    }

    this.maxMemory = options.maxMemoryMB * 1024 * 1024;
    this.evictionThreshold = options.evictionThreshold || 0.8;
    this.onEvict = options.onEvict || (() => {});
    this.coldLoader = options.coldLoader || (() => Promise.resolve(null));

    this.documents = new Map();
    this.collections = new Map();
    this.usedMemory = 0;
  }

  /**
   * Estimates memory size of a string value
   * @param {string} str - The string to estimate
   * @returns {number} Estimated size in bytes
   */
  estimateSize(str) {
    return str.length * 2 + 64;
  }

  /**
   * Sets a value in the cache
   * @param {string} key - Document key
   * @param {string} value - Serialized document value
   * @param {boolean} dirty - Whether the entry is dirty (default true)
   * @returns {Promise<void>}
   */
  async set(key, value, dirty = true) {
    const size = this.estimateSize(value);

    const existing = this.documents.get(key);
    if (existing && !existing.cold) {
      this.usedMemory -= existing.size;
    }

    this.documents.set(key, {
      data: value,
      size,
      lastAccess: Date.now(),
      accessCount: existing?.accessCount ? existing.accessCount + 1 : 1,
      dirty,
      cold: false
    });
    this.usedMemory += size;

    if (this.needsEviction()) {
      await this.evict();
    }
  }

  /**
   * Gets a value from the cache, loading from cold storage if needed
   * @param {string} key - Document key
   * @returns {Promise<string|null>} The document value or null
   */
  async get(key) {
    const entry = this.documents.get(key);
    if (!entry) return null;

    // Cold reference - load from cold storage
    if (entry.cold) {
      const value = await this.coldLoader(key);
      if (value === null) {
        this.documents.delete(key);
        return null;
      }

      // Promote back to hot tier
      const size = this.estimateSize(value);
      this.documents.set(key, {
        data: value,
        size,
        lastAccess: Date.now(),
        accessCount: 1,
        dirty: false,
        cold: false
      });
      this.usedMemory += size;

      console.log(`HotTier: Loaded ${key} from cold storage`);
      return value;
    }

    entry.lastAccess = Date.now();
    entry.accessCount++;

    return entry.data;
  }

  /**
   * Checks if a key exists in the cache
   * @param {string} key - Document key
   * @returns {boolean} True if key exists
   */
  has(key) {
    return this.documents.has(key);
  }

  /**
   * Checks if a key is a cold reference
   * @param {string} key - Document key
   * @returns {boolean} True if the entry is cold
   */
  isCold(key) {
    const entry = this.documents.get(key);
    return entry?.cold === true;
  }

  /**
   * Deletes a key from the cache
   * @param {string} key - Document key
   */
  delete(key) {
    const entry = this.documents.get(key);
    if (entry) {
      if (!entry.cold) {
        this.usedMemory -= entry.size;
      }
      this.documents.delete(key);
    }
  }

  /**
   * Renames a key in the cache
   * @param {string} oldKey - Current key
   * @param {string} newKey - New key
   */
  rename(oldKey, newKey) {
    const entry = this.documents.get(oldKey);
    if (entry) {
      this.documents.delete(oldKey);
      this.documents.set(newKey, entry);
    }
  }

  /**
   * Marks an entry as clean (not dirty)
   * @param {string} key - Document key
   */
  markClean(key) {
    const entry = this.documents.get(key);
    if (entry && !entry.cold) {
      entry.dirty = false;
    }
  }

  /**
   * Gets all dirty entries that need to be persisted
   * @returns {Array<{key: string, value: string}>} Array of dirty entries
   */
  getDirtyEntries() {
    const dirty = [];
    for (const [key, entry] of this.documents) {
      if (!entry.cold && entry.dirty) {
        dirty.push({ key, value: entry.data });
      }
    }
    return dirty;
  }

  /** @param {string} setName @param {string} member */
  sAdd(setName, member) {
    let set = this.collections.get(setName);
    if (!set) { set = new Set(); this.collections.set(setName, set); }
    set.add(member);
  }

  /** @param {string} setName @returns {Array<string>} */
  sMembers(setName) {
    const set = this.collections.get(setName);
    return set ? Array.from(set) : [];
  }

  /** @param {string} setName @param {string} member */
  sRem(setName, member) {
    const set = this.collections.get(setName);
    if (set) set.delete(member);
  }

  /** @param {string} setName @returns {boolean} */
  sExists(setName) {
    return this.collections.has(setName);
  }

  /**
   * Clears all data from the cache
   */
  clear() {
    this.documents.clear();
    this.collections.clear();
    this.usedMemory = 0;
  }

  /**
   * Gets cache statistics
   * @returns {Object} Statistics including document counts, memory usage
   */
  getStats() {
    let hotCount = 0;
    let coldCount = 0;
    for (const entry of this.documents.values()) {
      if (entry.cold) coldCount++;
      else hotCount++;
    }

    return {
      hotDocuments: hotCount,
      coldReferences: coldCount,
      collectionCount: this.collections.size,
      usedMemoryMB: Math.round(this.usedMemory / 1024 / 1024 * 100) / 100,
      maxMemoryMB: Math.round(this.maxMemory / 1024 / 1024),
      usagePercent: Math.round(this.usedMemory / this.maxMemory * 100)
    };
  }
}

// Attach snapshot and eviction methods to prototype
Object.assign(HotTierCache.prototype, createSnapshotMethods());
Object.assign(HotTierCache.prototype, createEvictionMethods());
