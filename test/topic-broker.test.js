import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTopicBroker } from "../lib/topic-broker.js";

describe("Topic Broker", () => {
  describe("publish", () => {
    it("returns 0 when no subscribers", () => {
      const broker = createTopicBroker();
      assert.equal(broker.publish("test", "hello"), 0);
    });

    it("delivers to subscribers", () => {
      const broker = createTopicBroker();
      const received = [];
      broker.subscribe("test", (env) => received.push(env));
      const count = broker.publish("test", "hello");
      assert.equal(count, 1);
      assert.equal(received.length, 1);
      assert.equal(received[0].message, "hello");
      assert.equal(received[0].topic, "test");
      assert.ok(received[0].timestamp > 0);
    });

    it("delivers to multiple subscribers", () => {
      const broker = createTopicBroker();
      const a = [], b = [];
      broker.subscribe("t", (env) => a.push(env));
      broker.subscribe("t", (env) => b.push(env));
      broker.publish("t", "msg");
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
    });

    it("does not cross-deliver between topics", () => {
      const broker = createTopicBroker();
      const received = [];
      broker.subscribe("a", (env) => received.push(env));
      broker.publish("b", "wrong");
      assert.equal(received.length, 0);
    });

    it("includes meta fields", () => {
      const broker = createTopicBroker();
      const received = [];
      broker.subscribe("t", (env) => received.push(env));
      broker.publish("t", "msg", { title: "Test" });
      assert.equal(received[0].title, "Test");
    });

    it("continues on subscriber error", () => {
      const broker = createTopicBroker();
      const received = [];
      broker.subscribe("t", () => { throw new Error("fail"); });
      broker.subscribe("t", (env) => received.push(env));
      const count = broker.publish("t", "msg");
      assert.equal(count, 1); // second subscriber still got it
      assert.equal(received.length, 1);
    });
  });

  describe("subscribe", () => {
    it("returns unsubscribe function", () => {
      const broker = createTopicBroker();
      const received = [];
      const unsub = broker.subscribe("t", (env) => received.push(env));
      broker.publish("t", "before");
      unsub();
      broker.publish("t", "after");
      assert.equal(received.length, 1);
      assert.equal(received[0].message, "before");
    });

    it("cleans up topic when last subscriber leaves", () => {
      const broker = createTopicBroker();
      const unsub = broker.subscribe("t", () => {});
      assert.equal(broker.listTopics().length, 1);
      unsub();
      assert.equal(broker.listTopics().length, 0);
    });
  });

  describe("listTopics", () => {
    it("returns empty array when no topics", () => {
      const broker = createTopicBroker();
      assert.deepEqual(broker.listTopics(), []);
    });

    it("returns topics with subscriber counts", () => {
      const broker = createTopicBroker();
      broker.subscribe("a", () => {});
      broker.subscribe("a", () => {});
      broker.subscribe("b", () => {});
      const topics = broker.listTopics();
      assert.equal(topics.length, 2);
      const a = topics.find(t => t.name === "a");
      const b = topics.find(t => t.name === "b");
      assert.equal(a.subscribers, 2);
      assert.equal(b.subscribers, 1);
    });
  });
});
