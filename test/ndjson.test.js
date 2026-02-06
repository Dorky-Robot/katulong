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
