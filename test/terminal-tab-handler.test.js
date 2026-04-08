import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Tab capture-phase handler regression tests.
 *
 * Tab is intercepted at the document level (capture phase) before xterm
 * sees it, so it must check that THIS terminal's helper textarea is the
 * focused element. Without that guard, two terminals in a pool both
 * fire on Tab and the keystroke is sent twice.
 *
 * The handler logic is small enough that we mirror it here against a
 * mock document. The shape of the implementation under test is in
 * public/lib/terminal-keyboard.js — `initTabHandler` inside
 * `createTerminalKeyboard`.
 */

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

describe("Tab capture handler", () => {
  let listeners;

  beforeEach(() => {
    listeners = setupDocMock();
  });

  it("REGRESSION: only the focused terminal sends Tab when multiple terminals share a pool", () => {
    const termA = createMockTerm("a");
    const termB = createMockTerm("b");
    const sendA = mock.fn();
    const sendB = mock.fn();

    createTabHandler(termA, sendA).initTabHandler();
    createTabHandler(termB, sendB).initTabHandler();

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

  it("ignores Tab with Ctrl/Alt/Meta", () => {
    const term = createMockTerm("a");
    const onSend = mock.fn();
    createTabHandler(term, onSend).initTabHandler();
    document._setActive(term._textarea);

    for (const mod of ["ctrlKey", "altKey", "metaKey"]) {
      const ev = makeTabEvent({ [mod]: true });
      for (const fn of (listeners["keydown:true"] || [])) fn(ev);
    }

    assert.equal(onSend.mock.callCount(), 0, "Tab with modifiers must not be intercepted");
  });
});
