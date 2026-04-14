/**
 * Durable Topic Broker — file-backed pub/sub for inter-session messaging.
 *
 * Topics are persisted as append-only JSONL files under ~/.katulong/pubsub/.
 * Each topic directory contains:
 *   log.jsonl  — one JSON envelope per line
 *   seq        — last sequence number (integer, atomic write)
 *
 * On publish: append to log, increment seq, deliver to in-memory subscribers.
 * On subscribe with fromSeq: replay from log, then switch to live delivery.
 * On restart: read seq files to resume numbering.
 *
 * Topic names use "/" as separators which map to directory paths.
 */

import { log as logger } from "./log.js";
import envConfig from "./env-config.js";
import {
  mkdirSync, appendFileSync, writeFileSync, readFileSync,
  statSync, renameSync, unlinkSync, readdirSync, existsSync, rmdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

// Rotation config by topic type
const HIGH_VOLUME_PREFIX = "sessions/";
const HIGH_VOLUME_MAX_BYTES = 1 * 1024 * 1024;   // 1 MB
const EVENT_MAX_BYTES = 100 * 1024;               // 100 KB
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isHighVolume(topic) {
  return topic.startsWith(HIGH_VOLUME_PREFIX);
}

function maxBytesFor(topic) {
  return isHighVolume(topic) ? HIGH_VOLUME_MAX_BYTES : EVENT_MAX_BYTES;
}

/**
 * Atomically write content to a file (write tmp, rename).
 */
function atomicWrite(filePath, content) {
  const tmp = filePath + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

/**
 * Read the seq file for a topic directory. Returns 0 if not found.
 */
function readSeq(dir) {
  try {
    const content = readFileSync(join(dir, "seq"), "utf8").trim();
    const n = parseInt(content, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Read envelopes from a JSONL file, optionally filtering by seq >= fromSeq.
 */
function readEnvelopes(filePath, fromSeq = 0) {
  const results = [];
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const env = JSON.parse(line);
        if (env.seq >= fromSeq) results.push(env);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist or unreadable
  }
  return results;
}

/**
 * Check if log needs rotation and rotate if so.
 * Renames log.jsonl -> log.jsonl.1 (removing old .1 first).
 */
function maybeRotate(dir, topic) {
  const logPath = join(dir, "log.jsonl");
  try {
    const stat = statSync(logPath);
    if (stat.size < maxBytesFor(topic)) return;
  } catch {
    return;
  }

  const rotatedPath = join(dir, "log.jsonl.1");

  // Remove old rotated file (keep max 2: current + .1)
  try { unlinkSync(rotatedPath); } catch { /* ok */ }

  // Rotate current -> .1
  try { renameSync(logPath, rotatedPath); } catch { /* ok */ }
}

/**
 * Prune old rotated files for event topics based on retention.
 */
function pruneOldFiles(dir, topic) {
  if (isHighVolume(topic)) return;

  const rotatedPath = join(dir, "log.jsonl.1");
  try {
    const stat = statSync(rotatedPath);
    if (Date.now() - stat.mtimeMs > EVENT_RETENTION_MS) {
      unlinkSync(rotatedPath);
    }
  } catch {
    // File doesn't exist
  }
}

/**
 * Recursively scan pubsub directory to discover topics and their seq numbers.
 */
function discoverTopics(baseDir) {
  const topics = new Map();

  function walk(dir, prefix) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const hasSeq = entries.some(e => e.name === "seq" && e.isFile());
    if (hasSeq && prefix) {
      topics.set(prefix, { seq: readSeq(dir) });
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        walk(join(dir, entry.name), childPrefix);
      }
    }
  }

  walk(baseDir, "");
  return topics;
}

export function createTopicBroker({ pubsubDir } = {}) {
  const PUBSUB_DIR = pubsubDir || join(envConfig.dataDir, "pubsub");

  function topicDir(topic) {
    const resolved = resolve(PUBSUB_DIR, topic);
    if (!resolved.startsWith(resolve(PUBSUB_DIR) + "/")) {
      throw new Error("Topic path escapes pubsub directory");
    }
    return resolved;
  }

  // Ensure pubsub root exists
  try { mkdirSync(PUBSUB_DIR, { recursive: true, mode: 0o700 }); } catch { /* ok */ }

  // In-memory subscriber tracking: topic -> Set<{ callback, id }>
  const subscribers = new Map();
  let subIdCounter = 0;

  // Per-topic sequence counters (loaded from disk on startup)
  const seqCounters = new Map();

  // Initialize seq counters from existing files
  const discovered = discoverTopics(PUBSUB_DIR);
  for (const [topic, { seq }] of discovered) {
    seqCounters.set(topic, seq);
    logger.debug("Restored topic seq", { topic, seq });
  }

  function getSeq(topic) {
    if (!seqCounters.has(topic)) {
      seqCounters.set(topic, readSeq(topicDir(topic)));
    }
    return seqCounters.get(topic);
  }

  function ensureTopicDir(topic) {
    const dir = topicDir(topic);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Subscribe to a topic.
   *
   * Options:
   *   fromSeq — replay messages starting at this sequence number before
   *             switching to live delivery.
   *
   * Returns an unsubscribe function.
   */
  function subscribe(topic, callback, { fromSeq } = {}) {
    if (!subscribers.has(topic)) subscribers.set(topic, new Set());
    const id = ++subIdCounter;
    const sub = { callback, id };

    // Replay from disk if requested
    if (fromSeq !== undefined && fromSeq !== null) {
      const dir = topicDir(topic);
      const from = Number(fromSeq);
      const rotated = readEnvelopes(join(dir, "log.jsonl.1"), from);
      const current = readEnvelopes(join(dir, "log.jsonl"), from);

      // Deduplicate — rotated and current may overlap during rotation.
      // Since both are sorted by seq, merge and skip duplicates.
      const seen = new Set();
      for (const env of [...rotated, ...current]) {
        if (seen.has(env.seq)) continue;
        seen.add(env.seq);
        try {
          callback(env);
        } catch (err) {
          logger.warn("Topic subscriber replay error", { topic, error: err.message });
        }
      }
    }

    // Register for live messages
    subscribers.get(topic).add(sub);

    return () => {
      const subs = subscribers.get(topic);
      if (subs) {
        subs.delete(sub);
        if (subs.size === 0) subscribers.delete(topic);
      }
    };
  }

  /**
   * Publish a message to a topic.
   *
   * Writes to disk, increments seq, then delivers to in-memory subscribers.
   * Returns the number of in-memory subscribers that received the message.
   */
  function publish(topic, message, meta = {}) {
    const dir = ensureTopicDir(topic);
    const currentSeq = getSeq(topic) + 1;
    seqCounters.set(topic, currentSeq);

    const envelope = {
      ...meta,
      seq: currentSeq,
      topic,
      message,
      timestamp: Date.now(),
    };

    const line = JSON.stringify(envelope) + "\n";

    // Append to log file
    try {
      appendFileSync(join(dir, "log.jsonl"), line, "utf8");
    } catch (err) {
      logger.warn("Failed to append to topic log", { topic, error: err.message });
    }

    // Atomically update seq file
    try {
      atomicWrite(join(dir, "seq"), String(currentSeq));
    } catch (err) {
      logger.warn("Failed to write seq file", { topic, error: err.message });
    }

    // Check rotation after write
    try { maybeRotate(dir, topic); } catch { /* ok */ }

    // Prune old rotated files for event topics
    try { pruneOldFiles(dir, topic); } catch { /* ok */ }

    // Deliver to in-memory subscribers
    const subs = subscribers.get(topic);
    if (!subs || subs.size === 0) return 0;

    let delivered = 0;
    for (const sub of subs) {
      try {
        sub.callback(envelope);
        delivered++;
      } catch (err) {
        logger.warn("Topic subscriber error", { topic, error: err.message });
      }
    }
    return delivered;
  }

  /**
   * Read topic metadata from meta.json. Returns {} if none.
   */
  function getMeta(topic) {
    try {
      return JSON.parse(readFileSync(join(topicDir(topic), "meta.json"), "utf8"));
    } catch {
      return {};
    }
  }

  /**
   * Set topic metadata. Merges with existing metadata (shallow).
   * Validates that meta is a non-null object — all callers rely on
   * this check so validation lives here, not in the route handlers.
   */
  function setMeta(topic, meta) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
    const dir = ensureTopicDir(topic);
    const existing = getMeta(topic);
    const merged = { ...existing, ...meta };
    atomicWrite(join(dir, "meta.json"), JSON.stringify(merged));
  }

  /**
   * List all known topics with metadata.
   * Merges on-disk topics with in-memory subscriber info.
   */
  function listTopics() {
    const allTopics = new Map();

    // On-disk topics
    const onDisk = discoverTopics(PUBSUB_DIR);
    for (const [name, { seq }] of onDisk) {
      allTopics.set(name, { name, subscribers: 0, seq, messages: seq, meta: getMeta(name) });
    }

    // In-memory subscribers
    for (const [name, subs] of subscribers) {
      if (allTopics.has(name)) {
        allTopics.get(name).subscribers = subs.size;
      } else {
        const seq = getSeq(name);
        allTopics.set(name, { name, subscribers: subs.size, seq, messages: seq, meta: getMeta(name) });
      }
    }

    return Array.from(allTopics.values());
  }

  /**
   * Delete a topic — removes on-disk files and in-memory state.
   * Returns true if the topic existed, false otherwise.
   */
  function deleteTopic(topic) {
    const dir = topicDir(topic);

    // Remove on-disk files
    let existed = false;
    for (const file of ["log.jsonl", "log.jsonl.1", "seq", "meta.json"]) {
      try { unlinkSync(join(dir, file)); existed = true; } catch { /* ok */ }
    }

    // Remove empty directories up the tree (topic "a/b/output" creates a/b/)
    let current = dir;
    const root = resolve(PUBSUB_DIR);
    while (current !== root && current.startsWith(root + "/")) {
      try { rmdirSync(current); } catch { break; } // only succeeds if empty
      current = resolve(current, "..");
    }

    // Clear in-memory state
    seqCounters.delete(topic);
    subscribers.delete(topic);

    return existed;
  }

  /**
   * Inspect a topic's log and return counts by message status.
   * Used by cleanup tooling to classify topics as noise vs. value
   * without re-streaming the whole log. Reads both the active log
   * and the rotated `.1` file when present.
   *
   * Messages are typically stringified JSON with a `status` field
   * (what our feed tiles use). We best-effort parse each envelope's
   * `message`; malformed or non-JSON messages land in `_unparsed`.
   *
   * Returns { seq, total, byStatus: { [status]: n, _unparsed: n } }.
   */
  function getTopicStats(topic) {
    const dir = topicDir(topic);
    const byStatus = {};
    let total = 0;

    for (const name of ["log.jsonl.1", "log.jsonl"]) {
      const envelopes = readEnvelopes(join(dir, name));
      for (const env of envelopes) {
        total++;
        let status;
        try {
          const parsed = typeof env.message === "string" ? JSON.parse(env.message) : env.message;
          status = parsed && typeof parsed === "object" ? parsed.status : undefined;
        } catch { /* fall through */ }
        const key = typeof status === "string" && status ? status : "_unparsed";
        byStatus[key] = (byStatus[key] || 0) + 1;
      }
    }

    return { seq: getSeq(topic), total, byStatus };
  }

  return { subscribe, publish, listTopics, getMeta, setMeta, deleteTopic, getTopicStats };
}
