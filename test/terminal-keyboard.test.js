import { describe, it, beforeEach, mock } from "node:test";
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
    // Option (Alt) app-level shortcuts — must NOT leak to the PTY.
    // Mirrors the block in terminal-keyboard.js.
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey && ev.type === "keydown") {
      if (ev.code === "KeyT" || ev.code === "KeyW" || ev.code === "KeyQ" ||
          ev.code === "KeyR" ||
          ev.code === "BracketLeft" || ev.code === "BracketRight" ||
          /^Digit[0-9]$/.test(ev.code || "")) return false;
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

// --- Tab capture-phase handler regression tests ---

// Reimplements the Tab capture-phase handler from terminal-keyboard.js
// to verify it only fires for the focused terminal.
function createTabHandler(term, onSend) {
  let _tabHandler = null;
  function initTabHandler() {
    if (_tabHandler) return;
    _tabHandler = (ev) => {
      if (ev.key !== "Tab" || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const active = document.activeElement;
      if (!active) return;
      const textarea = term?.element?.querySelector(".xterm-helper-textarea");
      if (active !== textarea) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (onSend) onSend(ev.shiftKey ? "\x1b[Z" : "\t");
    };
    document.addEventListener("keydown", _tabHandler, true);
  }
  return { initTabHandler };
}

function createMockTerm(id) {
  const textarea = { _id: `textarea-${id}` };
  return {
    element: {
      querySelector(sel) { return sel === ".xterm-helper-textarea" ? textarea : null; },
    },
    _textarea: textarea,
  };
}

function setupDocMock() {
  const listeners = {};
  let _active = null;
  globalThis.document = {
    get activeElement() { return _active; },
    addEventListener(type, fn, capture) {
      const key = `${type}:${!!capture}`;
      (listeners[key] = listeners[key] || []).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const key = `${type}:${!!capture}`;
      if (listeners[key]) listeners[key] = listeners[key].filter(f => f !== fn);
    },
    _setActive(el) { _active = el; },
    _listeners: listeners,
  };
  return listeners;
}

function makeTabEvent(opts = {}) {
  return {
    key: "Tab", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault: mock.fn(), stopPropagation: mock.fn(), ...opts,
  };
}

describe("Terminal keyboard — Tab capture handler (regression)", () => {
  let listeners;

  beforeEach(() => {
    listeners = setupDocMock();
  });

  it("REGRESSION: multiple terminals — only focused terminal sends Tab", () => {
    const termA = createMockTerm("a");
    const termB = createMockTerm("b");
    const sendA = mock.fn();
    const sendB = mock.fn();

    createTabHandler(termA, sendA).initTabHandler();
    createTabHandler(termB, sendB).initTabHandler();

    // Focus terminal B
    document._setActive(termB._textarea);

    const ev = makeTabEvent();
    for (const fn of (listeners["keydown:true"] || [])) fn(ev);

    assert.equal(sendA.mock.callCount(), 0, "unfocused terminal A must NOT send Tab");
    assert.equal(sendB.mock.callCount(), 1, "focused terminal B must send Tab exactly once");
  });

  it("REGRESSION: double initTabHandler does not duplicate listener", () => {
    const term = createMockTerm("a");
    const onSend = mock.fn();
    const kb = createTabHandler(term, onSend);
    kb.initTabHandler();
    kb.initTabHandler();

    document._setActive(term._textarea);

    const ev = makeTabEvent();
    for (const fn of (listeners["keydown:true"] || [])) fn(ev);

    assert.equal(onSend.mock.callCount(), 1, "double init must not cause double send");
  });

  it("does not fire when non-terminal element is focused", () => {
    const term = createMockTerm("a");
    const onSend = mock.fn();
    createTabHandler(term, onSend).initTabHandler();

    document._setActive({ _id: "search-input" });

    const ev = makeTabEvent();
    for (const fn of (listeners["keydown:true"] || [])) fn(ev);

    assert.equal(onSend.mock.callCount(), 0);
  });

  it("sends \\x1b[Z for Shift+Tab", () => {
    const term = createMockTerm("a");
    const onSend = mock.fn();
    createTabHandler(term, onSend).initTabHandler();

    document._setActive(term._textarea);

    const ev = makeTabEvent({ shiftKey: true });
    for (const fn of (listeners["keydown:true"] || [])) fn(ev);

    assert.equal(onSend.mock.calls[0].arguments[0], "\x1b[Z");
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

describe("Terminal keyboard — Option app shortcuts don't leak to PTY", () => {
  // Regression: every Option shortcut bound at the app level (tab management,
  // jump-to-tab, rename) must be blocked here. Otherwise xterm.js with
  // macOptionIsMeta=true sends ESC-prefixed sequences to the shell — e.g.
  // Option+1 → \e1 (readline digit-argument), Option+R → \er (revert-line).
  let handler, sent;

  beforeEach(() => {
    ({ handler, sent } = createKeyHandler());
  });

  const cases = [
    ["Option+T", { code: "KeyT", key: "t" }],
    ["Option+W", { code: "KeyW", key: "w" }],
    ["Option+Q", { code: "KeyQ", key: "q" }],
    ["Option+R", { code: "KeyR", key: "r" }],
    ["Option+[", { code: "BracketLeft", key: "[" }],
    ["Option+]", { code: "BracketRight", key: "]" }],
    ["Option+1", { code: "Digit1", key: "1" }],
    ["Option+2", { code: "Digit2", key: "2" }],
    ["Option+5", { code: "Digit5", key: "5" }],
    ["Option+9", { code: "Digit9", key: "9" }],
    ["Option+0", { code: "Digit0", key: "0" }],
  ];

  for (const [label, overrides] of cases) {
    it(`${label} is blocked and nothing is sent to the PTY`, () => {
      const result = handler(makeEvent({ ...overrides, altKey: true, type: "keydown" }));
      assert.equal(result, false, `${label} must be blocked`);
      assert.equal(sent.length, 0, `${label} must not send anything`);
    });
  }

  it("Option+ArrowLeft still sends word-back (not accidentally swallowed)", () => {
    const result = handler(makeEvent({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, type: "keydown" }));
    assert.equal(result, false);
    assert.equal(sent[0], "\x1bb");
  });
});
