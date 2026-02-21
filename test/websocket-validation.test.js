import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAttach,
  validateInput,
  validateResize,
  validateMessage,
} from "../lib/websocket-validation.js";

describe("validateAttach", () => {
  it("accepts valid attach message", () => {
    const msg = { type: "attach", cols: 80, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, true);
  });

  it("accepts valid attach message with session", () => {
    const msg = { type: "attach", session: "my-session", cols: 80, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, true);
  });

  it("rejects when type is not 'attach'", () => {
    const msg = { type: "input", cols: 80, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /type/i);
  });

  it("rejects when cols is not a number", () => {
    const msg = { type: "attach", cols: "80", rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /cols/i);
  });

  it("rejects when cols is negative", () => {
    const msg = { type: "attach", cols: -80, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /cols/i);
  });

  it("rejects when cols is zero", () => {
    const msg = { type: "attach", cols: 0, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /cols/i);
  });

  it("rejects when cols is a float", () => {
    const msg = { type: "attach", cols: 80.5, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /cols/i);
  });

  it("rejects when rows is not a number", () => {
    const msg = { type: "attach", cols: 80, rows: "24" };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /rows/i);
  });

  it("rejects when cols is too large", () => {
    const msg = { type: "attach", cols: 1001, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /1000/);
  });

  it("rejects when rows is too large", () => {
    const msg = { type: "attach", cols: 80, rows: 1001 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /1000/);
  });

  it("rejects when session is not a string", () => {
    const msg = { type: "attach", session: 123, cols: 80, rows: 24 };
    const result = validateAttach(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /session/i);
  });

  it("rejects when message is not an object", () => {
    const result = validateAttach("not an object");
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });

  it("rejects null", () => {
    const result = validateAttach(null);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });
});

describe("validateInput", () => {
  it("accepts valid input message", () => {
    const msg = { type: "input", data: "hello" };
    const result = validateInput(msg);
    assert.strictEqual(result.valid, true);
  });

  it("accepts empty data string", () => {
    const msg = { type: "input", data: "" };
    const result = validateInput(msg);
    assert.strictEqual(result.valid, true);
  });

  it("rejects when type is not 'input'", () => {
    const msg = { type: "attach", data: "hello" };
    const result = validateInput(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /type/i);
  });

  it("rejects when data is not a string", () => {
    const msg = { type: "input", data: 123 };
    const result = validateInput(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /data/i);
  });

  it("rejects when data is missing", () => {
    const msg = { type: "input" };
    const result = validateInput(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /data/i);
  });

  it("rejects when message is not an object", () => {
    const result = validateInput("not an object");
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });
});

describe("validateResize", () => {
  it("accepts valid resize message", () => {
    const msg = { type: "resize", cols: 100, rows: 30 };
    const result = validateResize(msg);
    assert.strictEqual(result.valid, true);
  });

  it("rejects when type is not 'resize'", () => {
    const msg = { type: "input", cols: 100, rows: 30 };
    const result = validateResize(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /type/i);
  });

  it("rejects when cols is not a number", () => {
    const msg = { type: "resize", cols: "100", rows: 30 };
    const result = validateResize(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /cols/i);
  });

  it("rejects when rows is not a number", () => {
    const msg = { type: "resize", cols: 100, rows: "30" };
    const result = validateResize(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /rows/i);
  });

  it("rejects when cols is too large", () => {
    const msg = { type: "resize", cols: 1001, rows: 30 };
    const result = validateResize(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /1000/);
  });

  it("rejects when message is not an object", () => {
    const result = validateResize("not an object");
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });
});

describe("validateMessage", () => {
  it("routes to validateAttach for attach messages", () => {
    const msg = { type: "attach", cols: 80, rows: 24 };
    const result = validateMessage(msg);
    assert.strictEqual(result.valid, true);
  });

  it("routes to validateInput for input messages", () => {
    const msg = { type: "input", data: "hello" };
    const result = validateMessage(msg);
    assert.strictEqual(result.valid, true);
  });

  it("routes to validateResize for resize messages", () => {
    const msg = { type: "resize", cols: 100, rows: 30 };
    const result = validateMessage(msg);
    assert.strictEqual(result.valid, true);
  });

  it("rejects unknown message types", () => {
    const msg = { type: "unknown", foo: "bar" };
    const result = validateMessage(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /unknown/i);
  });

  it("rejects when type is not a string", () => {
    const msg = { type: 123 };
    const result = validateMessage(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /type.*string/i);
  });

  it("rejects when type is missing", () => {
    const msg = { data: "hello" };
    const result = validateMessage(msg);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /type.*string/i);
  });

  it("rejects when message is not an object", () => {
    const result = validateMessage("not an object");
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });

  it("rejects arrays", () => {
    const result = validateMessage([]);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });

  it("rejects null", () => {
    const result = validateMessage(null);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /object/i);
  });
});
