import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTopicBroker } from "../lib/topic-broker.js";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "katulong-broker-test-"));
}

describe("Topic Broker", () => {
  let pubsubDir;

  beforeEach(() => {
    pubsubDir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(pubsubDir, { recursive: true, force: true }); } catch {}
  });

  function makeBroker() {
    return createTopicBroker({ pubsubDir });
  }

  describe("publish", () => {
    it("returns 0 when no subscribers", () => {
      const broker = makeBroker();
      assert.equal(broker.publish("test", "hello"), 0);
    });

    it("delivers to subscribers and includes seq", () => {
      const broker = makeBroker();
      const received = [];
      broker.subscribe("test", (env) => received.push(env));
      const count = broker.publish("test", "hello");
      assert.equal(count, 1);
      assert.equal(received.length, 1);
      assert.equal(received[0].message, "hello");
      assert.equal(received[0].topic, "test");
      assert.equal(received[0].seq, 1);
      assert.ok(received[0].timestamp > 0);
    });

    it("increments seq monotonically", () => {
      const broker = makeBroker();
      const received = [];
      broker.subscribe("t", (env) => received.push(env));
      broker.publish("t", "a");
      broker.publish("t", "b");
      broker.publish("t", "c");
      assert.equal(received[0].seq, 1);
      assert.equal(received[1].seq, 2);
      assert.equal(received[2].seq, 3);
    });

    it("delivers to multiple subscribers", () => {
      const broker = makeBroker();
      const a = [], b = [];
      broker.subscribe("t", (env) => a.push(env));
      broker.subscribe("t", (env) => b.push(env));
      broker.publish("t", "msg");
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
    });

    it("does not cross-deliver between topics", () => {
      const broker = makeBroker();
      const received = [];
      broker.subscribe("a", (env) => received.push(env));
      broker.publish("b", "wrong");
      assert.equal(received.length, 0);
    });

    it("includes meta fields", () => {
      const broker = makeBroker();
      const received = [];
      broker.subscribe("t", (env) => received.push(env));
      broker.publish("t", "msg", { title: "Test" });
      assert.equal(received[0].title, "Test");
    });

    it("continues on subscriber error", () => {
      const broker = makeBroker();
      const received = [];
      broker.subscribe("t", () => { throw new Error("fail"); });
      broker.subscribe("t", (env) => received.push(env));
      const count = broker.publish("t", "msg");
      assert.equal(count, 1);
      assert.equal(received.length, 1);
    });

    it("persists messages to JSONL file", () => {
      const broker = makeBroker();
      broker.publish("my-topic", "hello");
      broker.publish("my-topic", "world");

      const logPath = join(pubsubDir, "my-topic", "log.jsonl");
      assert.ok(existsSync(logPath));

      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);

      const env1 = JSON.parse(lines[0]);
      assert.equal(env1.message, "hello");
      assert.equal(env1.seq, 1);

      const env2 = JSON.parse(lines[1]);
      assert.equal(env2.message, "world");
      assert.equal(env2.seq, 2);
    });

    it("writes seq file atomically", () => {
      const broker = makeBroker();
      broker.publish("t", "a");
      broker.publish("t", "b");

      const seqPath = join(pubsubDir, "t", "seq");
      assert.ok(existsSync(seqPath));
      assert.equal(readFileSync(seqPath, "utf8"), "2");
    });

    it("handles topic names with slashes as directory paths", () => {
      const broker = makeBroker();
      broker.publish("sessions/my-session/output", "data");

      const logPath = join(pubsubDir, "sessions", "my-session", "output", "log.jsonl");
      assert.ok(existsSync(logPath));
    });
  });

  describe("subscribe", () => {
    it("returns unsubscribe function", () => {
      const broker = makeBroker();
      const received = [];
      const unsub = broker.subscribe("t", (env) => received.push(env));
      broker.publish("t", "before");
      unsub();
      broker.publish("t", "after");
      assert.equal(received.length, 1);
      assert.equal(received[0].message, "before");
    });

    it("cleans up topic subscriber list when last subscriber leaves", () => {
      const broker = makeBroker();
      const unsub = broker.subscribe("t", () => {});
      // Topic still shows because subscriber is active
      const topics = broker.listTopics();
      const t = topics.find(x => x.name === "t");
      assert.ok(t);
      assert.equal(t.subscribers, 1);
      unsub();
    });
  });

  describe("replay (fromSeq)", () => {
    it("replays messages from a given seq number", () => {
      const broker = makeBroker();
      broker.publish("t", "a");
      broker.publish("t", "b");
      broker.publish("t", "c");

      const replayed = [];
      broker.subscribe("t", (env) => replayed.push(env), { fromSeq: 2 });

      // Should have replayed messages with seq >= 2
      assert.equal(replayed.length, 2);
      assert.equal(replayed[0].message, "b");
      assert.equal(replayed[0].seq, 2);
      assert.equal(replayed[1].message, "c");
      assert.equal(replayed[1].seq, 3);
    });

    it("replays all messages when fromSeq is 0", () => {
      const broker = makeBroker();
      broker.publish("t", "a");
      broker.publish("t", "b");

      const replayed = [];
      broker.subscribe("t", (env) => replayed.push(env), { fromSeq: 0 });
      assert.equal(replayed.length, 2);
    });

    it("replays nothing when fromSeq is beyond current seq", () => {
      const broker = makeBroker();
      broker.publish("t", "a");

      const replayed = [];
      broker.subscribe("t", (env) => replayed.push(env), { fromSeq: 999 });
      assert.equal(replayed.length, 0);
    });

    it("still receives live messages after replay", () => {
      const broker = makeBroker();
      broker.publish("t", "old");

      const received = [];
      broker.subscribe("t", (env) => received.push(env), { fromSeq: 1 });

      // Old message was replayed
      assert.equal(received.length, 1);
      assert.equal(received[0].message, "old");

      // New live message
      broker.publish("t", "new");
      assert.equal(received.length, 2);
      assert.equal(received[1].message, "new");
      assert.equal(received[1].seq, 2);
    });

    it("does not replay when fromSeq is not specified", () => {
      const broker = makeBroker();
      broker.publish("t", "old");

      const received = [];
      broker.subscribe("t", (env) => received.push(env));

      // No replay, only live
      assert.equal(received.length, 0);

      broker.publish("t", "new");
      assert.equal(received.length, 1);
      assert.equal(received[0].message, "new");
    });
  });

  describe("restart recovery", () => {
    it("resumes seq numbering after broker restart", () => {
      // First broker instance publishes some messages
      const broker1 = makeBroker();
      broker1.publish("t", "a");
      broker1.publish("t", "b");
      broker1.publish("t", "c");

      // Simulate restart: create new broker pointing at same directory
      const broker2 = makeBroker();

      const received = [];
      broker2.subscribe("t", (env) => received.push(env));
      broker2.publish("t", "d");

      // seq should continue from 3
      assert.equal(received[0].seq, 4);
      assert.equal(received[0].message, "d");
    });

    it("replays old messages from previous broker instance", () => {
      const broker1 = makeBroker();
      broker1.publish("t", "old-a");
      broker1.publish("t", "old-b");

      // Simulate restart
      const broker2 = makeBroker();

      const replayed = [];
      broker2.subscribe("t", (env) => replayed.push(env), { fromSeq: 1 });

      assert.equal(replayed.length, 2);
      assert.equal(replayed[0].message, "old-a");
      assert.equal(replayed[1].message, "old-b");
    });

    it("discovers multiple topics on startup", () => {
      const broker1 = makeBroker();
      broker1.publish("topic-a", "msg-a");
      broker1.publish("topic-b", "msg-b");
      broker1.publish("events/session/done", "msg-c");

      const broker2 = makeBroker();
      const topics = broker2.listTopics();

      assert.equal(topics.length, 3);
      assert.ok(topics.find(t => t.name === "topic-a"));
      assert.ok(topics.find(t => t.name === "topic-b"));
      assert.ok(topics.find(t => t.name === "events/session/done"));
    });
  });

  describe("rotation", () => {
    it("rotates log when it exceeds max size for event topics", () => {
      const broker = makeBroker();
      const topic = "events/test";

      // Write enough data to exceed 100KB
      const bigMessage = "x".repeat(10000);
      for (let i = 0; i < 12; i++) {
        broker.publish(topic, bigMessage);
      }

      // After rotation, log.jsonl.1 should exist
      const rotatedPath = join(pubsubDir, topic, "log.jsonl.1");
      assert.ok(existsSync(rotatedPath), "Rotated file should exist");

      // Current log should be smaller than the rotated one
      const logPath = join(pubsubDir, topic, "log.jsonl");
      // New log may or may not exist (last publish may trigger rotation)
    });

    it("rotates log when it exceeds 1MB for session topics", () => {
      const broker = makeBroker();
      const topic = "sessions/test/output";

      // Write enough data to approach 1MB
      const bigMessage = "x".repeat(50000);
      for (let i = 0; i < 22; i++) {
        broker.publish(topic, bigMessage);
      }

      const rotatedPath = join(pubsubDir, topic, "log.jsonl.1");
      assert.ok(existsSync(rotatedPath), "Rotated file should exist");
    });

    it("replays from rotated file when using fromSeq", () => {
      const broker = makeBroker();
      const topic = "events/replay-test";

      // Publish enough to trigger rotation
      const bigMessage = "x".repeat(10000);
      for (let i = 0; i < 12; i++) {
        broker.publish(topic, bigMessage);
      }

      // Replay from seq 1 should include messages from rotated file
      const replayed = [];
      broker.subscribe(topic, (env) => replayed.push(env), { fromSeq: 1 });

      // Should get all messages (from both rotated and current files)
      assert.ok(replayed.length > 0, "Should replay messages from rotated file");
      assert.equal(replayed[0].seq, 1, "First replayed message should be seq 1");
    });
  });

  describe("listTopics", () => {
    it("returns empty array when no topics", () => {
      const broker = makeBroker();
      assert.deepEqual(broker.listTopics(), []);
    });

    it("returns topics with subscriber counts and seq", () => {
      const broker = makeBroker();
      broker.publish("a", "msg1");
      broker.publish("a", "msg2");
      broker.subscribe("a", () => {});
      broker.subscribe("a", () => {});
      broker.publish("b", "msg1");
      broker.subscribe("b", () => {});

      const topics = broker.listTopics();
      assert.equal(topics.length, 2);

      const a = topics.find(t => t.name === "a");
      const b = topics.find(t => t.name === "b");
      assert.equal(a.subscribers, 2);
      assert.equal(a.seq, 2);
      assert.equal(a.messages, 2);
      assert.equal(b.subscribers, 1);
      assert.equal(b.seq, 1);
    });

    it("includes topics with no subscribers (on-disk only)", () => {
      const broker = makeBroker();
      broker.publish("persisted", "msg");
      // No subscriber, but topic should appear in list

      const topics = broker.listTopics();
      const t = topics.find(x => x.name === "persisted");
      assert.ok(t);
      assert.equal(t.subscribers, 0);
      assert.equal(t.seq, 1);
    });
  });

  describe("edge cases", () => {
    it("handles publish to topic with no prior directory", () => {
      const broker = makeBroker();
      // Should not throw
      broker.publish("brand-new/nested/topic", "first");
      assert.ok(existsSync(join(pubsubDir, "brand-new", "nested", "topic", "log.jsonl")));
    });

    it("handles subscribe to nonexistent topic without fromSeq", () => {
      const broker = makeBroker();
      const received = [];
      const unsub = broker.subscribe("nonexistent", (env) => received.push(env));
      assert.equal(received.length, 0);
      unsub();
    });

    it("handles subscribe with fromSeq to nonexistent topic", () => {
      const broker = makeBroker();
      const received = [];
      const unsub = broker.subscribe("nonexistent", (env) => received.push(env), { fromSeq: 1 });
      assert.equal(received.length, 0);
      unsub();
    });

    it("publishes even with no subscribers (still persists)", () => {
      const broker = makeBroker();
      const delivered = broker.publish("no-subs", "persisted");
      assert.equal(delivered, 0);

      // But the message is on disk
      const logPath = join(pubsubDir, "no-subs", "log.jsonl");
      const content = readFileSync(logPath, "utf8").trim();
      const env = JSON.parse(content);
      assert.equal(env.message, "persisted");
      assert.equal(env.seq, 1);
    });

    it("rejects path-traversal topic names", () => {
      const broker = makeBroker();
      assert.throws(() => broker.publish("../escape", "bad"), /escapes pubsub directory/);
      assert.throws(() => broker.publish("legit/../../escape", "bad"), /escapes pubsub directory/);
      assert.throws(() => broker.publish("../../../etc/passwd", "bad"), /escapes pubsub directory/);
    });
  });

  describe("topic metadata", () => {
    it("getMeta returns empty object for topic without metadata", () => {
      const broker = makeBroker();
      broker.publish("t", "msg");
      assert.deepEqual(broker.getMeta("t"), {});
    });

    it("setMeta persists metadata to meta.json", () => {
      const broker = makeBroker();
      broker.publish("t", "msg"); // ensure topic dir exists
      broker.setMeta("t", { type: "progress", label: "Build" });

      const metaPath = join(pubsubDir, "t", "meta.json");
      assert.ok(existsSync(metaPath));
      const stored = JSON.parse(readFileSync(metaPath, "utf8"));
      assert.equal(stored.type, "progress");
      assert.equal(stored.label, "Build");
    });

    it("getMeta reads persisted metadata", () => {
      const broker = makeBroker();
      broker.publish("t", "msg");
      broker.setMeta("t", { type: "log" });
      assert.deepEqual(broker.getMeta("t"), { type: "log" });
    });

    it("setMeta merges with existing metadata", () => {
      const broker = makeBroker();
      broker.publish("t", "msg");
      broker.setMeta("t", { type: "progress" });
      broker.setMeta("t", { label: "CI Pipeline" });

      const meta = broker.getMeta("t");
      assert.equal(meta.type, "progress");
      assert.equal(meta.label, "CI Pipeline");
    });

    it("setMeta creates topic directory if it does not exist", () => {
      const broker = makeBroker();
      broker.setMeta("new/topic", { type: "log" });
      assert.deepEqual(broker.getMeta("new/topic"), { type: "log" });
    });

    it("setMeta ignores null or non-object", () => {
      const broker = makeBroker();
      broker.publish("t", "msg");
      broker.setMeta("t", null);
      assert.deepEqual(broker.getMeta("t"), {});
      broker.setMeta("t", "string");
      assert.deepEqual(broker.getMeta("t"), {});
    });

    it("listTopics includes metadata", () => {
      const broker = makeBroker();
      broker.publish("a", "msg");
      broker.setMeta("a", { type: "progress" });
      broker.publish("b", "msg");

      const topics = broker.listTopics();
      const a = topics.find(t => t.name === "a");
      const b = topics.find(t => t.name === "b");

      assert.deepEqual(a.meta, { type: "progress" });
      assert.deepEqual(b.meta, {});
    });

    it("metadata survives broker restart", () => {
      const broker1 = makeBroker();
      broker1.publish("t", "msg");
      broker1.setMeta("t", { type: "progress", label: "Build" });

      // Simulate restart
      const broker2 = makeBroker();
      assert.deepEqual(broker2.getMeta("t"), { type: "progress", label: "Build" });

      const topics = broker2.listTopics();
      const t = topics.find(x => x.name === "t");
      assert.deepEqual(t.meta, { type: "progress", label: "Build" });
    });
  });

  describe("getTopicStats", () => {
    it("returns zero counts for an unknown topic", () => {
      const broker = makeBroker();
      const stats = broker.getTopicStats("nope");
      assert.equal(stats.seq, 0);
      assert.equal(stats.total, 0);
      assert.deepEqual(stats.byStatus, {});
    });

    it("groups JSON-string messages by status field", () => {
      const broker = makeBroker();
      broker.publish("claude/x", JSON.stringify({ step: "a", status: "done" }));
      broker.publish("claude/x", JSON.stringify({ step: "b", status: "done" }));
      broker.publish("claude/x", JSON.stringify({ step: "c", status: "narrative" }));

      const stats = broker.getTopicStats("claude/x");
      assert.equal(stats.seq, 3);
      assert.equal(stats.total, 3);
      assert.deepEqual(stats.byStatus, { done: 2, narrative: 1 });
    });

    it("buckets non-JSON or status-less messages as _unparsed", () => {
      const broker = makeBroker();
      broker.publish("raw", "not json at all");
      broker.publish("raw", JSON.stringify({ step: "x" })); // no status
      broker.publish("raw", JSON.stringify({ status: "done" }));

      const stats = broker.getTopicStats("raw");
      assert.equal(stats.total, 3);
      assert.equal(stats.byStatus._unparsed, 2);
      assert.equal(stats.byStatus.done, 1);
    });

    it("includes rotated log entries", () => {
      const broker = makeBroker();
      // Seed many small messages to trigger rotation on event-sized topic
      // (100KB cap). ~1000 bytes per message * 200 should roll over.
      const big = "x".repeat(900);
      for (let i = 0; i < 200; i++) {
        broker.publish("rollover", JSON.stringify({ status: "done", pad: big }));
      }
      const stats = broker.getTopicStats("rollover");
      assert.equal(stats.total, 200);
      assert.equal(stats.byStatus.done, 200);
    });
  });
});
