/**
 * @file Graph state and prefix-enumeration helpers for InHouseAdapter.
 *
 * Domain context: graph adjacency is durable database state, while graph
 * algorithms also need efficient collection-local document scans that include
 * hot and cold rows without going through reactive entity wrappers.
 *
 * Technical context: these methods are mixed into `InHouseAdapter` so the main
 * class remains a coordinator under the repository source-line gate.
 */

import JSS from '../../utils/jss/index.js';

/**
 * Create graph-state helper methods mixed into `InHouseAdapter`.
 *
 * @returns {Object} Graph bind/recovery and prefix-enumeration methods.
 */
export function createGraphStateMethods() {
  return {
    /**
     * Bind the registry-owned GraphIndex and drain pending recovery state.
     *
     * @param {Object} graphIndex - GraphIndex instance from schema registry.
     * @returns {void}
     */
    bindGraphIndex(graphIndex) {
      this._graphIndex = graphIndex;
      if (this._pendingGraphState) {
        graphIndex.load(this._pendingGraphState);
        this._pendingGraphState = null;
      }
      if (this._deferredGraphOps && this._deferredGraphOps.length > 0) {
        for (const op of this._deferredGraphOps) {
          if (op.op === 'insert') graphIndex.insertEdge(op.collection, op.doc);
          else if (op.op === 'remove') graphIndex.removeEdge(op.collection, op.doc);
        }
        this._deferredGraphOps = null;
      }
    },

    /**
     * Return snapshot-loaded GraphIndex state waiting for registry bind.
     *
     * @returns {Object|null} Pending serialized GraphIndex state or null.
     */
    getPendingGraphState() {
      return this._pendingGraphState || null;
    },

    /**
     * Capture GraphIndex state during recovery for later registry binding.
     *
     * @param {Object|null} state - GraphIndex.serialize() output, or null.
     * @returns {void}
     */
    setPendingGraphState(state) {
      this._pendingGraphState = state || null;
    },

    /**
     * Enumerate hot-tier document bodies for one durable collection prefix.
     *
     * @param {string} prefix - Four-character collection storage identity.
     * @returns {Array<Object>} Parsed hot document bodies.
     */
    iterateHotDocsByPrefix(prefix) {
      if (!this.hotTier) return [];
      const members = this.hotTier.sMembers(`${prefix}?`);
      const out = [];
      for (const member of members) {
        const fullId = `${prefix}_${member}`;
        const entry = this.hotTier.documents.get(fullId);
        if (!entry || entry.cold || !entry.data) continue;
        try { out.push(JSS.parse(entry.data)); } catch (_) { /* skip bad body */ }
      }
      return out;
    },

    /**
     * Enumerate hot and cold document bodies for one durable collection prefix.
     *
     * @param {string} prefix - Four-character collection storage identity.
     * @returns {Promise<Array<Object>>} Parsed document bodies in any order.
     */
    async getDocsByPrefix(prefix) {
      if (!this.hotTier) return [];
      const members = this.hotTier.sMembers(`${prefix}?`);
      const out = [];
      for (const member of members) {
        const fullId = `${prefix}_${member}`;
        const data = await this.hotTier.get(fullId);
        if (typeof data !== 'string') continue;
        try { out.push(JSS.parse(data)); } catch (_) { /* skip bad body */ }
      }
      return out;
    }
  };
}
