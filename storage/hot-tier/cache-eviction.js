/**
 * @file Eviction logic for HotTierCache
 * Handles LRU-based eviction of cache entries to cold storage
 */

/**
 * Creates eviction methods to be attached to HotTierCache prototype
 * @returns {Object} Object containing eviction-related methods
 */
export function createEvictionMethods() {
  return {
    /**
     * Calculates eviction score for an entry (lower = more likely to evict)
     * Uses a frequency-weighted algorithm based on access patterns
     * @param {Object} entry - Cache entry with lastAccess and accessCount
     * @returns {number} Eviction score
     */
    calculateScore(entry) {
      return entry.lastAccess * Math.log(entry.accessCount + 1);
    },

    /**
     * Checks if memory usage exceeds eviction threshold
     * @returns {boolean} True if eviction is needed
     */
    needsEviction() {
      return this.usedMemory > this.maxMemory * this.evictionThreshold;
    },

    /**
     * Evicts least-recently-used items to cold storage
     * Selects candidates based on score, skipping cold references and dirty entries
     * @returns {Promise<void>}
     */
    async evict() {
      if (!this.needsEviction()) return;

      const candidates = [];
      for (const [key, entry] of this.documents) {
        // Skip cold references (already evicted)
        if (entry.cold) continue;
        // Skip dirty entries
        if (entry.dirty) continue;

        candidates.push({
          key,
          score: this.calculateScore(entry),
          size: entry.size
        });
      }

      candidates.sort((a, b) => a.score - b.score);

      const targetMemory = this.maxMemory * this.evictionThreshold * 0.8;
      let evicted = 0;

      for (const candidate of candidates) {
        if (this.usedMemory <= targetMemory) break;

        const entry = this.documents.get(candidate.key);
        if (entry && !entry.cold) {
          // Write to cold storage
          await this.onEvict(candidate.key, entry.data);

          // Replace with cold reference (promise-based)
          this.documents.set(candidate.key, {
            cold: true,
            key: candidate.key
          });

          this.usedMemory -= entry.size;
          evicted++;
        }
      }

      if (evicted > 0) {
        console.log(`HotTier: Evicted ${evicted} entries to cold, memory: ${Math.round(this.usedMemory / 1024 / 1024)}MB`);
      }
    }
  };
}
