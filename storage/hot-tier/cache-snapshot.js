/**
 * @file Snapshot and bulk loading methods for HotTierCache
 * Handles serialization of cache state and bulk data loading for recovery
 */

/**
 * Creates snapshot methods to be attached to HotTierCache prototype
 * @returns {Object} Object containing snapshot and bulk load methods
 */
export function createSnapshotMethods() {
  return {
    /**
     * Get all hot documents as a simple key-value object
     * @returns {Object} Map of document keys to their data values
     */
    getAllDocuments() {
      const docs = {};
      for (const [key, entry] of this.documents) {
        // Only include hot entries in snapshot
        if (!entry.cold) {
          docs[key] = entry.data;
        }
      }
      return docs;
    },

    /**
     * Get all documents for snapshot with resolved references
     * Parses JSS strings to objects and resolves ID references to actual object pointers
     * @param {Function} parseJSS - JSS.parse function for deserializing document strings
     * @returns {Object} Documents with resolved references
     */
    getAllDocumentsForSnapshot(parseJSS) {
      // First pass: parse all documents to objects
      const docs = {};
      for (const [key, entry] of this.documents) {
        if (!entry.cold) {
          docs[key] = parseJSS(entry.data);
        }
      }

      /**
       * Recursively resolves ID references to actual objects
       * @param {Object} obj - Object to process
       * @param {WeakSet} visited - Set of already visited objects to prevent cycles
       */
      const resolveRefs = (obj, visited = new WeakSet()) => {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);

        for (const [key, value] of Object.entries(obj)) {
          // Skip $ID and metadata fields
          if (key === '$ID' || key === 'createdAt' || key === 'updatedAt' ||
              key === 'deletedAt' || key === 'deletedBy') continue;

          // Resolve string ID to object reference
          if (typeof value === 'string' && value.includes('_') && docs[value]) {
            obj[key] = docs[value];
          }
          // Resolve array of IDs
          else if (Array.isArray(value)) {
            obj[key] = value.map(v =>
              typeof v === 'string' && v.includes('_') && docs[v] ? docs[v] : v
            );
            // Recurse into array elements that are objects
            for (const item of obj[key]) {
              if (typeof item === 'object' && item !== null) {
                resolveRefs(item, visited);
              }
            }
          }
          // Recurse into nested objects
          else if (typeof value === 'object' && value !== null) {
            resolveRefs(value, visited);
          }
        }
      };

      for (const doc of Object.values(docs)) {
        resolveRefs(doc);
      }

      return docs;
    },

    /**
     * Get all collections as a simple object
     * @returns {Object} Map of collection names to arrays of members
     */
    getAllCollections() {
      const cols = {};
      for (const [name, set] of this.collections) {
        cols[name] = Array.from(set);
      }
      return cols;
    },

    /**
     * Bulk load documents into the cache
     * Used for recovery from snapshots
     * @param {Object} docs - Map of document keys to their serialized values
     */
    loadDocuments(docs) {
      for (const [key, value] of Object.entries(docs)) {
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
      }
    },

    /**
     * Bulk load collections into the cache
     * Used for recovery from snapshots
     * @param {Object} cols - Map of collection names to arrays of members
     */
    loadCollections(cols) {
      for (const [name, members] of Object.entries(cols)) {
        this.collections.set(name, new Set(members));
      }
    }
  };
}
