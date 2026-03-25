/**
 * Topic Broker — in-memory pub/sub for inter-session messaging.
 *
 * Topics are ephemeral (no persistence). Subscribers receive messages
 * in real-time. Used by:
 * - CLI: `katulong pub/sub` commands
 * - API: POST /pub, GET /sub/:topic (SSE)
 * - Internal: bridge relay for browser notifications
 */

import { log } from "./log.js";

export function createTopicBroker() {
  // topic -> Set<{ callback, id }>
  const topics = new Map();
  let subIdCounter = 0;

  function subscribe(topic, callback) {
    if (!topics.has(topic)) topics.set(topic, new Set());
    const id = ++subIdCounter;
    const sub = { callback, id };
    topics.get(topic).add(sub);

    // Return unsubscribe function
    return () => {
      const subs = topics.get(topic);
      if (subs) {
        subs.delete(sub);
        if (subs.size === 0) topics.delete(topic);
      }
    };
  }

  function publish(topic, message, meta = {}) {
    const subs = topics.get(topic);
    if (!subs || subs.size === 0) return 0;

    const envelope = {
      topic,
      message,
      timestamp: Date.now(),
      ...meta,
    };

    let delivered = 0;
    for (const sub of subs) {
      try {
        sub.callback(envelope);
        delivered++;
      } catch (err) {
        log.warn("Topic subscriber error", { topic, error: err.message });
      }
    }
    return delivered;
  }

  function listTopics() {
    return Array.from(topics.entries()).map(([name, subs]) => ({
      name,
      subscribers: subs.size,
    }));
  }

  return { subscribe, publish, listTopics };
}
