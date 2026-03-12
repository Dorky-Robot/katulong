/**
 * Transport Bridge
 *
 * Unified relay for session manager events. Each transport (WebSocket)
 * registers a subscriber callback. The session manager calls relay(), which
 * dispatches the message to all registered subscribers.
 */

import { log } from "./log.js";

export function createTransportBridge() {
  const subscribers = new Set();

  return {
    /**
     * Register a transport subscriber.
     * Returns an unsubscribe function.
     *
     * @param {(msg: object) => void} subscriber
     * @returns {() => void}
     */
    register(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },

    /**
     * Relay a session event to all registered transports.
     *
     * Each subscriber is called independently. If one throws, the error is
     * logged but other subscribers still receive the message.
     *
     * @param {object} msg
     */
    relay(msg) {
      for (const subscriber of subscribers) {
        try {
          subscriber(msg);
        } catch (err) {
          log.error("transport-bridge subscriber error", { error: err?.message || String(err) });
        }
      }
    },
  };
}
