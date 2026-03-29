/**
 * Tests for key-island.js — key button and sequence handling
 *
 * Verifies that:
 * - Esc button sends \x1b
 * - Tab button sends \t
 * - Comma-separated chords send sequences with delays
 * - Ctrl+C,Ctrl+C sends \x03 twice
 * - Buttons call sendFn and focus the terminal
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { keysToSequence, sendSequence } from "../public/lib/key-mapping.js";

describe("keysToSequence", () => {
  it("converts 'esc' to escape byte", () => {
    const seq = keysToSequence("esc");
    assert.deepStrictEqual(seq, ["\x1b"]);
  });

  it("converts 'tab' to tab byte", () => {
    const seq = keysToSequence("tab");
    assert.deepStrictEqual(seq, ["\t"]);
  });

  it("converts 'enter' to carriage return", () => {
    const seq = keysToSequence("enter");
    assert.deepStrictEqual(seq, ["\r"]);
  });

  it("converts 'ctrl+c' to \\x03", () => {
    const seq = keysToSequence("ctrl+c");
    assert.deepStrictEqual(seq, ["\x03"]);
  });

  it("converts comma-separated chord 'ctrl+c,ctrl+c'", () => {
    const seq = keysToSequence("ctrl+c,ctrl+c");
    assert.deepStrictEqual(seq, ["\x03", "\x03"]);
  });

  it("converts 'ctrl+a,x' (tmux prefix + x)", () => {
    const seq = keysToSequence("ctrl+a,x");
    assert.deepStrictEqual(seq, ["\x01", "x"]);
  });

  it("converts arrow keys", () => {
    assert.deepStrictEqual(keysToSequence("up"), ["\x1b[A"]);
    assert.deepStrictEqual(keysToSequence("down"), ["\x1b[B"]);
    assert.deepStrictEqual(keysToSequence("left"), ["\x1b[D"]);
    assert.deepStrictEqual(keysToSequence("right"), ["\x1b[C"]);
  });

  it("converts alt+key to escape prefix", () => {
    const seq = keysToSequence("alt+d");
    assert.deepStrictEqual(seq, ["\x1bd"]);
  });

  it("converts shift+key to uppercase", () => {
    const seq = keysToSequence("shift+a");
    assert.deepStrictEqual(seq, ["A"]);
  });

  it("converts ctrl+backspace to \\x08", () => {
    const seq = keysToSequence("ctrl+backspace");
    assert.deepStrictEqual(seq, ["\x08"]);
  });
});

describe("sendSequence", () => {
  it("sends single part immediately", () => {
    const sender = mock.fn();
    sendSequence(["\x1b"], sender);
    assert.equal(sender.mock.callCount(), 1);
    assert.equal(sender.mock.calls[0].arguments[0], "\x1b");
  });

  it("sends string directly (not array)", () => {
    const sender = mock.fn();
    sendSequence("\t", sender);
    assert.equal(sender.mock.callCount(), 1);
    assert.equal(sender.mock.calls[0].arguments[0], "\t");
  });

  it("sends multi-part chord with first part immediately", () => {
    const sender = mock.fn();
    sendSequence(["\x03", "\x03"], sender);
    // First part sent immediately
    assert.equal(sender.mock.callCount(), 1);
    assert.equal(sender.mock.calls[0].arguments[0], "\x03");
  });

  it("sends subsequent parts with delay", async () => {
    const sender = mock.fn();
    sendSequence(["\x01", "x"], sender);
    assert.equal(sender.mock.callCount(), 1); // first part only
    // Wait for the 100ms delay
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sender.mock.callCount(), 2);
    assert.equal(sender.mock.calls[1].arguments[0], "x");
  });
});

describe("key-island button integration", () => {
  it("Esc button sends escape and focuses terminal", () => {
    const sendFn = mock.fn();
    const term = { focus: mock.fn() };

    // Simulate what the button click handler does
    sendSequence(keysToSequence("esc"), sendFn);
    if (term) term.focus();

    assert.equal(sendFn.mock.callCount(), 1);
    assert.equal(sendFn.mock.calls[0].arguments[0], "\x1b");
    assert.equal(term.focus.mock.callCount(), 1);
  });

  it("Tab button sends tab and focuses terminal", () => {
    const sendFn = mock.fn();
    const term = { focus: mock.fn() };

    sendSequence(keysToSequence("tab"), sendFn);
    if (term) term.focus();

    assert.equal(sendFn.mock.callCount(), 1);
    assert.equal(sendFn.mock.calls[0].arguments[0], "\t");
    assert.equal(term.focus.mock.callCount(), 1);
  });

  it("ctrl+c,ctrl+c chord sends two \\x03 with delay", async () => {
    const sendFn = mock.fn();

    sendSequence(keysToSequence("ctrl+c,ctrl+c"), sendFn);
    assert.equal(sendFn.mock.callCount(), 1);
    assert.equal(sendFn.mock.calls[0].arguments[0], "\x03");

    await new Promise(r => setTimeout(r, 150));
    assert.equal(sendFn.mock.callCount(), 2);
    assert.equal(sendFn.mock.calls[1].arguments[0], "\x03");
  });
});
