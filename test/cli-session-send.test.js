import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveKey, buildPayload } from "../lib/cli/key-map.js";

describe("CLI key-map: resolveKey", () => {
  it("resolves Enter to CR", () => {
    assert.equal(resolveKey("Enter"), "\r");
  });

  it("resolves Escape to ESC", () => {
    assert.equal(resolveKey("Escape"), "\x1b");
    assert.equal(resolveKey("Esc"), "\x1b");
  });

  it("resolves Tab, Backspace, Space", () => {
    assert.equal(resolveKey("Tab"), "\t");
    assert.equal(resolveKey("Backspace"), "\x7f");
    assert.equal(resolveKey("Space"), " ");
  });

  it("resolves arrow keys to xterm sequences", () => {
    assert.equal(resolveKey("Up"), "\x1b[A");
    assert.equal(resolveKey("Down"), "\x1b[B");
    assert.equal(resolveKey("Right"), "\x1b[C");
    assert.equal(resolveKey("Left"), "\x1b[D");
  });

  it("resolves C-a..C-z to control bytes", () => {
    assert.equal(resolveKey("C-a"), "\x01");
    assert.equal(resolveKey("C-c"), "\x03");
    assert.equal(resolveKey("C-z"), "\x1a");
  });

  it("accepts case-insensitive control letters", () => {
    assert.equal(resolveKey("C-C"), "\x03");
  });

  it("resolves F1..F4 (SS3) and F5..F12 (CSI ~)", () => {
    assert.equal(resolveKey("F1"), "\x1bOP");
    assert.equal(resolveKey("F4"), "\x1bOS");
    assert.equal(resolveKey("F5"), "\x1b[15~");
    assert.equal(resolveKey("F12"), "\x1b[24~");
  });

  it("throws a clear error on unknown key", () => {
    assert.throws(
      () => resolveKey("NotAKey"),
      /Unknown key name: "NotAKey"/,
    );
  });

  it("throws on empty string", () => {
    assert.throws(() => resolveKey(""), /non-empty string/);
  });
});

describe("CLI key-map: buildPayload", () => {
  it("returns empty payload for empty argv", () => {
    const r = buildPayload([]);
    assert.equal(r.payload, "");
    assert.equal(r.hadKey, false);
    assert.equal(r.hadText, false);
  });

  it("treats positional tokens as text", () => {
    const r = buildPayload(["hello"]);
    assert.equal(r.payload, "hello");
    assert.equal(r.hadText, true);
    assert.equal(r.hadKey, false);
  });

  it("--enter is equivalent to --key Enter", () => {
    const a = buildPayload(["--enter"]);
    const b = buildPayload(["--key", "Enter"]);
    assert.equal(a.payload, b.payload);
    assert.equal(a.payload, "\r");
    assert.equal(a.hadKey, true);
  });

  it("preserves argv order across text and keys", () => {
    const r = buildPayload(["hello", "--key", "Enter", "--key", "C-c"]);
    assert.equal(r.payload, "hello\r\x03");
  });

  it("interleaves multiple text fragments and keys in order", () => {
    const r = buildPayload(["echo ", "hi", "--enter"]);
    assert.equal(r.payload, "echo hi\r");
  });

  it("throws if --key has no name argument", () => {
    assert.throws(() => buildPayload(["--key"]), /requires a key name/);
  });

  it("throws on unknown key name through buildPayload", () => {
    assert.throws(
      () => buildPayload(["--key", "Bogus"]),
      /Unknown key name: "Bogus"/,
    );
  });
});
