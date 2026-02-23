/**
 * Transport Bridge
 *
 * Unified relay for daemon broadcast messages. Each transport (WebSocket, SSH)
 * registers a subscriber callback. The daemon data handler calls relay(), which
 * dispatches the message to all registered subscribers.
 *
 * This eliminates the duplicate message-type dispatch previously spread across
 * server.js and lib/ssh.js.
 */

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
     * Relay a daemon broadcast message to all registered transports.
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
          console.error('[transport-bridge] subscriber error:', err);
        }
      }
    },
  };
}
