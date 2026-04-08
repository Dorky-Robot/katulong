import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decideTerminalKey } from "../public/lib/terminal-key-decider.js";
import { decideAppKey } from "../public/lib/app-keyboard.js";

/**
 * Keyboard shortcut spec — single source of truth.
 *
 * These tests pin down EVERY shortcut katulong supports. They run against
 * the real exported decision functions (no reimplemented copy), so any
 * drift between implementation and spec breaks here.
 *
 * Spec lives in docs/keyboard-shortcuts.md. The kb-help overlay in
 * index.html must stay in sync with the spec — see kb-help-overlay test.
 *
 * Decision function contracts:
 *
 *   decideTerminalKey(ev) → { action, sequence, allowDefault }
 *     action:        symbolic name ("clear", "search", "lineStart", null, ...)
 *     sequence:      string to write to PTY, or null
 *     allowDefault:  return value for xterm's attachCustomKeyEventHandler
 *                    — true = let xterm process, false = block
 *
 *   decideAppKey(ev, ctx) → { action, args, preventDefault }
 *     action:        symbolic name ("newSession", "navigateTab", ...)
 *     args:          arguments for the action (e.g. tab index)
 *     preventDefault: whether to call ev.preventDefault()
 *     ctx:           { isTextInput: bool } — set when target is input/textarea
 *
 * Tests target the spec, not the wiring. Wiring is verified by integration
 * tests; here we verify the decisions.
 */

function ev(overrides = {}) {
  return {
    key: "",
    code: "",
    type: "keydown",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// TERMINAL-LEVEL DECISIONS (decideTerminalKey)
// ─────────────────────────────────────────────────────────────────────────

describe("decideTerminalKey — Option (Alt) terminal shortcuts", () => {
  it("Option+F → toggle search, blocks PTY", () => {
    const r = decideTerminalKey(ev({ key: "f", code: "KeyF", altKey: true }));
    assert.equal(r.action, "toggleSearch");
    assert.equal(r.allowDefault, false);
    assert.equal(r.sequence, null);
  });

  it("Option+K → clear terminal, blocks PTY", () => {
    const r = decideTerminalKey(ev({ key: "k", code: "KeyK", altKey: true }));
    assert.equal(r.action, "clearTerminal");
    assert.equal(r.allowDefault, false);
    assert.equal(r.sequence, null);
  });

  it("Option+Backspace → delete line (\\x15)", () => {
    const r = decideTerminalKey(ev({ key: "Backspace", code: "Backspace", altKey: true }));
    assert.equal(r.sequence, "\x15");
    assert.equal(r.allowDefault, false);
  });

  it("Option+Left → start of line (\\x01)", () => {
    const r = decideTerminalKey(ev({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }));
    assert.equal(r.sequence, "\x01");
    assert.equal(r.allowDefault, false);
  });

  it("Option+Right → end of line (\\x05)", () => {
    const r = decideTerminalKey(ev({ key: "ArrowRight", code: "ArrowRight", altKey: true }));
    assert.equal(r.sequence, "\x05");
    assert.equal(r.allowDefault, false);
  });
});

describe("decideTerminalKey — Shift+Enter (kitty CSI u)", () => {
  it("sends \\x1b[13;2u on keydown, blocks PTY", () => {
    const r = decideTerminalKey(ev({ key: "Enter", shiftKey: true, type: "keydown" }));
    assert.equal(r.sequence, "\x1b[13;2u");
    assert.equal(r.allowDefault, false);
  });

  it("blocks keypress without sending (prevents \\r leak)", () => {
    const r = decideTerminalKey(ev({ key: "Enter", shiftKey: true, type: "keypress" }));
    assert.equal(r.sequence, null);
    assert.equal(r.allowDefault, false);
  });

  it("blocks keyup without sending", () => {
    const r = decideTerminalKey(ev({ key: "Enter", shiftKey: true, type: "keyup" }));
    assert.equal(r.sequence, null);
    assert.equal(r.allowDefault, false);
  });

  it("plain Enter → allow xterm to process", () => {
    const r = decideTerminalKey(ev({ key: "Enter", type: "keydown" }));
    assert.equal(r.allowDefault, true);
    assert.equal(r.sequence, null);
  });
});

describe("decideTerminalKey — Tab", () => {
  // Tab is consumed by the document-level capture handler, not by xterm.
  // The custom handler must therefore tell xterm to skip it.
  it("Tab is blocked (handled by capture-phase listener)", () => {
    const r = decideTerminalKey(ev({ key: "Tab", code: "Tab" }));
    assert.equal(r.allowDefault, false);
  });
});

describe("decideTerminalKey — clipboard passthroughs", () => {
  it("Cmd+C with selection → allow browser copy", () => {
    const r = decideTerminalKey(ev({ key: "c", metaKey: true }), { hasSelection: true });
    assert.equal(r.allowDefault, false);
  });

  it("Cmd+V → allow browser paste", () => {
    const r = decideTerminalKey(ev({ key: "v", metaKey: true }));
    assert.equal(r.allowDefault, false);
  });

  it("Ctrl+V → allow browser paste", () => {
    const r = decideTerminalKey(ev({ key: "v", ctrlKey: true }));
    assert.equal(r.allowDefault, false);
  });

  it("Ctrl+C without selection → reach PTY (SIGINT)", () => {
    const r = decideTerminalKey(ev({ key: "c", ctrlKey: true }), { hasSelection: false });
    assert.equal(r.allowDefault, true);
  });
});

describe("decideTerminalKey — app-level Option keys are blocked from PTY", () => {
  // Regression: every Option shortcut bound at the app level must be
  // blocked here. Otherwise xterm.js with macOptionIsMeta=true sends
  // ESC-prefixed sequences to the shell — e.g. Option+1 → \e1
  // (readline digit-argument), Option+R → \er (revert-line).
  const appLevelKeys = [
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

  for (const [label, overrides] of appLevelKeys) {
    it(`${label} is blocked and emits no PTY sequence`, () => {
      const r = decideTerminalKey(ev({ ...overrides, altKey: true }));
      assert.equal(r.allowDefault, false, `${label} must be blocked from PTY`);
      assert.equal(r.sequence, null, `${label} must not send to PTY`);
    });
  }
});

describe("decideTerminalKey — accidental mappings (negative coverage)", () => {
  // Anything NOT in the spec must reach the PTY untouched. If a future
  // change accidentally adds a mapping for a common key, this catches it.
  const passThroughKeys = [
    ["a", { key: "a", code: "KeyA" }],
    ["A", { key: "A", code: "KeyA", shiftKey: true }],
    ["Cmd+A", { key: "a", code: "KeyA", metaKey: true }],
    ["plain ArrowUp", { key: "ArrowUp", code: "ArrowUp" }],
    ["plain ArrowDown", { key: "ArrowDown", code: "ArrowDown" }],
    ["Cmd+ArrowLeft (browser nav, not us)", { key: "ArrowLeft", code: "ArrowLeft", metaKey: true }],
    ["Cmd+K (NOT in spec — was the doc bug)", { key: "k", code: "KeyK", metaKey: true }],
    ["Cmd+F (NOT in spec — browser find)", { key: "f", code: "KeyF", metaKey: true }],
  ];

  for (const [label, overrides] of passThroughKeys) {
    it(`${label} → no side effect, reaches PTY`, () => {
      const r = decideTerminalKey(ev(overrides));
      assert.equal(r.action, null, `${label} must not trigger an action (got ${r.action})`);
      assert.equal(r.sequence, null, `${label} must not emit a sequence (got ${JSON.stringify(r.sequence)})`);
      assert.equal(r.allowDefault, true, `${label} must let xterm handle it`);
    });
  }
});

describe("decideTerminalKey — REGRESSION: word-back/word-forward removed", () => {
  // Option+ArrowLeft used to be double-mapped: once to start-of-line
  // (reachable) and once to word-back (\x1bb, unreachable). The dead
  // mapping was removed. These tests prevent it from coming back.
  it("Option+ArrowLeft never sends \\x1bb (word-back)", () => {
    const r = decideTerminalKey(ev({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }));
    assert.notEqual(r.sequence, "\x1bb", "Option+Left must NOT send word-back");
    assert.equal(r.sequence, "\x01", "Option+Left must send start-of-line");
  });

  it("Option+ArrowRight never sends \\x1bf (word-forward)", () => {
    const r = decideTerminalKey(ev({ key: "ArrowRight", code: "ArrowRight", altKey: true }));
    assert.notEqual(r.sequence, "\x1bf");
    assert.equal(r.sequence, "\x05");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// APP-LEVEL DECISIONS (decideAppKey)
// ─────────────────────────────────────────────────────────────────────────

describe("decideAppKey — Cmd shortcuts", () => {
  it("Cmd+/ → toggle keyboard help", () => {
    const r = decideAppKey(ev({ key: "/", metaKey: true }));
    assert.equal(r.action, "toggleHelp");
    assert.equal(r.preventDefault, true);
  });

  it("Cmd+Shift+/ → no action (only plain Cmd+/)", () => {
    const r = decideAppKey(ev({ key: "/", metaKey: true, shiftKey: true }));
    assert.equal(r.action, null);
  });
});

describe("decideAppKey — Option tab management", () => {
  it("Option+T → new session", () => {
    const r = decideAppKey(ev({ code: "KeyT", key: "t", altKey: true }));
    assert.equal(r.action, "newSession");
    assert.equal(r.preventDefault, true);
  });

  it("Option+W → close session", () => {
    const r = decideAppKey(ev({ code: "KeyW", key: "w", altKey: true }));
    assert.equal(r.action, "closeSession");
    assert.equal(r.preventDefault, true);
  });

  it("Option+Shift+W → kill session", () => {
    const r = decideAppKey(ev({ code: "KeyW", key: "W", altKey: true, shiftKey: true }));
    assert.equal(r.action, "killSession");
    assert.equal(r.preventDefault, true);
  });

  it("Option+Q → kill session (alias)", () => {
    const r = decideAppKey(ev({ code: "KeyQ", key: "q", altKey: true }));
    assert.equal(r.action, "killSession");
    assert.equal(r.preventDefault, true);
  });

  it("Option+R → rename current session", () => {
    const r = decideAppKey(ev({ code: "KeyR", key: "r", altKey: true }));
    assert.equal(r.action, "renameSession");
    assert.equal(r.preventDefault, true);
  });

  it("Option+[ → previous tab", () => {
    const r = decideAppKey(ev({ code: "BracketLeft", key: "[", altKey: true }));
    assert.equal(r.action, "navigateTab");
    assert.equal(r.args, -1);
  });

  it("Option+] → next tab", () => {
    const r = decideAppKey(ev({ code: "BracketRight", key: "]", altKey: true }));
    assert.equal(r.action, "navigateTab");
    assert.equal(r.args, 1);
  });

  it("Option+Shift+[ → move tab left", () => {
    const r = decideAppKey(ev({ code: "BracketLeft", key: "{", altKey: true, shiftKey: true }));
    assert.equal(r.action, "moveTab");
    assert.equal(r.args, -1);
  });

  it("Option+Shift+] → move tab right", () => {
    const r = decideAppKey(ev({ code: "BracketRight", key: "}", altKey: true, shiftKey: true }));
    assert.equal(r.action, "moveTab");
    assert.equal(r.args, 1);
  });
});

describe("decideAppKey — Option jump-to-tab", () => {
  for (let i = 1; i <= 9; i++) {
    it(`Option+${i} → jump to tab ${i}`, () => {
      const r = decideAppKey(ev({ code: `Digit${i}`, key: String(i), altKey: true }));
      assert.equal(r.action, "jumpToTab");
      assert.equal(r.args, i);
    });
  }

  it("Option+0 → jump to tab 10", () => {
    const r = decideAppKey(ev({ code: "Digit0", key: "0", altKey: true }));
    assert.equal(r.action, "jumpToTab");
    assert.equal(r.args, 10);
  });
});

describe("decideAppKey — text input guard", () => {
  // Option shortcuts must NOT fire while the user is typing into an input,
  // textarea, or contenteditable. Otherwise Option+R re-enters the rename
  // flow while the rename input is already focused, etc.
  it("Option+T inside input → no action", () => {
    const r = decideAppKey(ev({ code: "KeyT", key: "t", altKey: true }), { isTextInput: true });
    assert.equal(r.action, null);
  });

  it("Option+R inside textarea → no action", () => {
    const r = decideAppKey(ev({ code: "KeyR", key: "r", altKey: true }), { isTextInput: true });
    assert.equal(r.action, null);
  });

  it("Cmd+/ inside input → still fires (help is global)", () => {
    const r = decideAppKey(ev({ key: "/", metaKey: true }), { isTextInput: true });
    assert.equal(r.action, "toggleHelp");
  });
});

describe("decideAppKey — accidental mappings (negative coverage)", () => {
  const passThroughKeys = [
    ["plain a", { key: "a", code: "KeyA" }],
    ["Cmd+T", { key: "t", code: "KeyT", metaKey: true }],
    ["Cmd+W", { key: "w", code: "KeyW", metaKey: true }],
    ["Cmd+1", { key: "1", code: "Digit1", metaKey: true }],
    ["Ctrl+T", { key: "t", code: "KeyT", ctrlKey: true }],
    ["Ctrl+Alt+T", { key: "t", code: "KeyT", ctrlKey: true, altKey: true }],
    ["Cmd+Alt+T", { key: "t", code: "KeyT", metaKey: true, altKey: true }],
  ];

  for (const [label, overrides] of passThroughKeys) {
    it(`${label} → no action`, () => {
      const r = decideAppKey(ev(overrides));
      assert.equal(r.action, null, `${label} must not trigger an action (got ${r.action})`);
    });
  }
});
