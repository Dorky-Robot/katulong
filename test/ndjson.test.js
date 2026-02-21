import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode, decoder } from "../lib/ndjson.js";

describe("encode", () => {
  it("returns JSON followed by a newline", () => {
    const result = encode({ type: "hello" });
    assert.equal(result, '{"type":"hello"}\n');
  });

  it("handles nested objects", () => {
    const result = encode({ a: { b: [1, 2] } });
    assert.equal(result, '{"a":{"b":[1,2]}}\n');
  });

  it("handles empty object", () => {
    assert.equal(encode({}), "{}\n");
  });
});

describe("decoder", () => {
  it("parses a single complete message", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"type":"ping"}\n');
    assert.deepEqual(messages, [{ type: "ping" }]);
  });

  it("parses multiple messages in one chunk", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"a":1}\n{"b":2}\n');
    assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  });

  it("handles messages split across chunks", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"type":');
    assert.equal(messages.length, 0);
    handler('"split"}\n');
    assert.deepEqual(messages, [{ type: "split" }]);
  });

  it("ignores malformed JSON and continues", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('not-json\n{"ok":true}\n');
    assert.deepEqual(messages, [{ ok: true }]);
  });

  it("handles empty lines between messages", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"a":1}\n\n{"b":2}\n');
    assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  });

  it("handles Buffer input", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler(Buffer.from('{"buf":true}\n'));
    assert.deepEqual(messages, [{ buf: true }]);
  });
});

describe("decoder - edge cases", () => {
  it("does not dispatch partial message without trailing newline", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"incomplete": true}'); // No newline
    assert.equal(messages.length, 0, "partial message without newline should not be dispatched");
  });

  it("dispatches partial message once newline arrives in later chunk", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"key": "val');      // incomplete
    assert.equal(messages.length, 0);
    handler('ue"}\n');            // completes the message
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { key: "value" });
  });

  it("handles very large JSON messages (1MB+ payload)", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    const bigValue = "x".repeat(1024 * 1024); // 1MB string
    handler(JSON.stringify({ data: bigValue }) + "\n");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].data.length, 1024 * 1024);
  });

  it("handles unicode characters including emoji and multi-byte sequences", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"emoji": "🎉🌍", "cjk": "日本語"}\n');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].emoji, "🎉🌍");
    assert.equal(messages[0].cjk, "日本語");
  });

  it("handles message arriving in many tiny chunks", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    const parts = ['{"', 'k', 'e', 'y', '"', ':', '"', 'v', 'a', 'l', '"', '}', '\n'];
    for (const part of parts) {
      handler(part);
    }
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { key: "val" });
  });

  it("handles connection drop mid-message: data before newline is silently dropped", () => {
    // Simulates connection drop by never sending the newline.
    // The buffered incomplete message should not be dispatched.
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler('{"drop": "this"'); // half a message, no newline
    // Simulate EOF / connection drop — just stop sending data
    assert.equal(messages.length, 0, "incomplete message at EOF should not be dispatched");
  });

  it("skips malformed lines and continues parsing subsequent valid messages", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    // Three messages: valid, invalid JSON, valid
    handler('{"a":1}\nnot-json\n{"b":2}\n');
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { a: 1 });
    assert.deepEqual(messages[1], { b: 2 });
  });

  it("handles a message whose value is JSON null", () => {
    const messages = [];
    const handler = decoder((msg) => messages.push(msg));
    handler("null\n");
    // null is valid JSON — decoder calls onMessage(null)
    assert.equal(messages.length, 1);
    assert.equal(messages[0], null);
  });
});
