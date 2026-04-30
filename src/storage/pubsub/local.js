/**
 * @file Process-local EventEmitter pub/sub for the in-house storage adapter.
 *
 * Single-process fan-out only; no replay for late subscribers.
 */

import { EventEmitter } from 'events';

/**
 * Process-local pub/sub bus backed by Node's EventEmitter. Used by the
 * in-house storage adapter to fan out change-publish events to
 * subscribers in the same process. No persistence; subscribers added
 * after a publish do not see prior events.
 *
 * @class LocalPubSub
 */
export class LocalPubSub {
  /**
   * Create an Emitter with unbounded listeners (setMaxListeners(0)).
   */
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0); // No limit on listeners
  }

  /**
   * Publish a message to a channel
   * @param {string} channel
   * @param {string} message
   */
  async publish(channel, message) {
    this.emitter.emit(channel, message);
  }

  /**
   * Subscribe to a channel
   * @param {string} channel
   * @param {(message: string) => void} callback
   */
  async subscribe(channel, callback) {
    this.emitter.on(channel, callback);
  }

  /**
   * Unsubscribe from a channel
   * @param {string} channel
   * @param {(message: string) => void} callback
   */
  async unsubscribe(channel, callback) {
    this.emitter.off(channel, callback);
  }

  /**
   * Get number of subscribers for a channel
   * @param {string} channel
   * @returns {number}
   */
  subscriberCount(channel) {
    return this.emitter.listenerCount(channel);
  }

  /**
   * Remove all subscribers
   */
  clear() {
    this.emitter.removeAllListeners();
  }
}
