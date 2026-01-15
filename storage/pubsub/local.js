/**
 * Local Pub/Sub - Process-local EventEmitter-based pub/sub
 *
 * Provides pub/sub interface for single-process use.
 */

import { EventEmitter } from 'events';

export class LocalPubSub {
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
