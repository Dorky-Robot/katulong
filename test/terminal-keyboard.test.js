import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Terminal keyboard handler tests
 *
 * Unit tests for the custom key event handler logic in terminal-keyboard.js.
 * Since the actual handler runs in the browser with xterm.js, these tests
 * exercise the same decision logic in isolation.
 */

// Replicate the custom key event handler logic from terminal-keyboard.js.
// This mirrors the attachCustomKeyEventHandler callback so we can test
// its decisions without a real xterm.js instance.
function createKeyHandler() {
  const sent = [];
  const onSend = (data) => sent.push(data);

  function handler(ev) {
    // Allow browser copy when text is selected
    if (ev.metaKey && ev.key === "c") return false;
    // Allow browser paste
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "v") return false;
    // Allow terminal Ctrl+C when no selection
    if (ev.ctrlKey && ev.key === "c") return true;
    // Tab handled by capture-phase listener
    if (ev.key === "Tab") return false;
    // Shift+Enter: block ALL event types, send kitty sequence on keydown only
    if (ev.shiftKey && ev.key === "Enter") {
      if (ev.type === "keydown") onSend("\x1b[13;2u");
      return false;
    }
    // Cmd/Meta key shortcuts
    if (ev.metaKey && ev.type === "keydown") {
      const metaSeq = {
        Backspace: "\x15",
        ArrowLeft: "\x01",
        ArrowRight: "\x05"
      }[ev.key];
      if (metaSeq) { onSend(metaSeq); return false; }
    }
    // Alt/Option key shortcuts
    if (ev.altKey && ev.type === "keydown") {
      const altSeq = {
        ArrowLeft: "\x1bb",
        ArrowRight: "\x1bf"
      }[ev.key];
      if (altSeq) { onSend(altSeq); return false; }
    }
    return true;
  }

  return { handler, sent };
}

function makeEvent(overrides) {
  return {
    key: "", type: "keydown",
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    ...overrides,
  };
}

describe("Terminal keyboard — Shift+Enter", () => {
  let handler, sent;

  beforeEach(() => {
    ({ handler, sent } = createKeyHandler());
  });

  it("sends kitty CSI u sequence on keydown", () => {
    const result = handler(makeEvent({ key: "Enter", shiftKey: true, type: "keydown" }));
    assert.equal(result, false, "should block xterm from processing");
    assert.equal(sent.length, 1);
    assert.equal(sent[0], "\x1b[13;2u");
  });

  it("blocks keypress without sending (prevents \\r leak)", () => {
    const result = handler(makeEvent({ key: "Enter", shiftKey: true, type: "keypress" }));
    assert.equal(result, false, "must block keypress to prevent \\r leak");
    assert.equal(sent.length, 0, "must NOT send anything on keypress");
  });

  it("blocks keyup without sending", () => {
    const result = handler(makeEvent({ key: "Enter", shiftKey: true, type: "keyup" }));
    assert.equal(result, false, "must block keyup");
    assert.equal(sent.length, 0, "must NOT send anything on keyup");
  });

  it("full keydown→keypress→keyup cycle sends exactly one sequence", () => {
    handler(makeEvent({ key: "Enter", shiftKey: true, type: "keydown" }));
    handler(makeEvent({ key: "Enter", shiftKey: true, type: "keypress" }));
    handler(makeEvent({ key: "Enter", shiftKey: true, type: "keyup" }));
    assert.equal(sent.length, 1, "must send exactly once across all event types");
    assert.equal(sent[0], "\x1b[13;2u");
  });
});

describe("Terminal keyboard — plain Enter", () => {
  it("allows xterm to process Enter (returns true)", () => {
    const { handler } = createKeyHandler();
    const result = handler(makeEvent({ key: "Enter", type: "keydown" }));
    assert.equal(result, true, "plain Enter should be handled by xterm");
  });
});

describe("Terminal keyboard — Tab", () => {
  it("blocks Tab (handled by capture-phase listener)", () => {
    const { handler } = createKeyHandler();
    const result = handler(makeEvent({ key: "Tab", type: "keydown" }));
    assert.equal(result, false);
  });
});

describe("Terminal keyboard — Meta shortcuts", () => {
  let handler, sent;

  beforeEach(() => {
    ({ handler, sent } = createKeyHandler());
  });

  it("Cmd+Backspace sends delete-line", () => {
    handler(makeEvent({ key: "Backspace", metaKey: true, type: "keydown" }));
    assert.equal(sent[0], "\x15");
  });

  it("Cmd+Left sends start-of-line", () => {
    handler(makeEvent({ key: "ArrowLeft", metaKey: true, type: "keydown" }));
    assert.equal(sent[0], "\x01");
  });

  it("Cmd+Right sends end-of-line", () => {
    handler(makeEvent({ key: "ArrowRight", metaKey: true, type: "keydown" }));
    assert.equal(sent[0], "\x05");
  });
});

describe("Terminal keyboard — Alt shortcuts", () => {
  let handler, sent;

  beforeEach(() => {
    ({ handler, sent } = createKeyHandler());
  });

  it("Alt+Left sends word-back", () => {
    handler(makeEvent({ key: "ArrowLeft", altKey: true, type: "keydown" }));
    assert.equal(sent[0], "\x1bb");
  });

  it("Alt+Right sends word-forward", () => {
    handler(makeEvent({ key: "ArrowRight", altKey: true, type: "keydown" }));
    assert.equal(sent[0], "\x1bf");
  });
});
