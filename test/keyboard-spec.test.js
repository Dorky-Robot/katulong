import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decideTerminalKey } from "../public/lib/terminal-key-decider.js";
import { decideAppKey, isTextInputTarget } from "../public/lib/app-keyboard.js";

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
  // REGRESSION: these tests simulate REAL macOS event shapes. With
  // macOptionIsMeta=true, pressing Option+F produces ev.key="ƒ" (Unicode
  // U+0192), not "f" — macOS substitutes the Option layer character
  // before the event reaches JS. Checking ev.key === "f" never matched
  // and the shortcut silently dropped. The decider must key off ev.code
  // (physical key, stable across layout and modifier).
  it("Option+F (macOS: ev.key='ƒ') → toggle search, blocks PTY", () => {
    const r = decideTerminalKey(ev({ key: "ƒ", code: "KeyF", altKey: true }));
    assert.equal(r.action, "toggleSearch");
    assert.equal(r.allowDefault, false);
    assert.equal(r.sequence, null);
  });

  it("Option+K (macOS: ev.key='˚') → clear terminal, blocks PTY", () => {
    const r = decideTerminalKey(ev({ key: "˚", code: "KeyK", altKey: true }));
    assert.equal(r.action, "clearTerminal");
    assert.equal(r.allowDefault, false);
    assert.equal(r.sequence, null);
  });

  // REGRESSION: Option+Space on macOS produces a non-breaking space
  // (U+00A0) in ev.key, so an `ev.key === " "` check would silently miss
  // every press. The decider must key off ev.code === "Space". Same trap
  // as Option+F / Option+K above (see c6f1c31 commit message).
  it("Option+Space (macOS: ev.key='\\u00a0') → toggle command palette, blocks PTY", () => {
    const r = decideTerminalKey(ev({ key: "\u00a0", code: "Space", altKey: true }));
    assert.equal(r.action, "togglePalette");
    assert.equal(r.allowDefault, false);
    assert.equal(r.sequence, null);
  });

  it("plain Space (no Option) → reaches PTY untouched", () => {
    const r = decideTerminalKey(ev({ key: " ", code: "Space" }));
    assert.equal(r.action, null);
    assert.equal(r.sequence, null);
    assert.equal(r.allowDefault, true);
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

describe("decideTerminalKey — Cmd+/ blocks all event types", () => {
  // Same reason as Shift+Enter: if we only block keydown, xterm's
  // _keyDownHandled stays false and _keyPress reprocesses the keypress,
  // sending "/" to the PTY.
  for (const type of ["keydown", "keypress", "keyup"]) {
    it(`Cmd+/ ${type} → blocked`, () => {
      const r = decideTerminalKey(ev({ key: "/", metaKey: true, type }));
      assert.equal(r.allowDefault, false, `Cmd+/ ${type} must not reach PTY`);
    });
  }
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

describe("decideAppKey — macOS real event shapes", () => {
  // REGRESSION: with macOptionIsMeta=true, macOS produces Option-layer
  // Unicode for Option+letter (e.g. Option+T → ev.key="†"). The decider
  // must key off ev.code, never ev.key, for Option shortcuts. If someone
  // adds an ev.key check later thinking "t" will match, these tests fail.
  const realMacShapes = [
    ["Option+T", { code: "KeyT", key: "†", altKey: true }, "newSession"],
    ["Option+W", { code: "KeyW", key: "∑", altKey: true }, "closeSession"],
    ["Option+Q", { code: "KeyQ", key: "œ", altKey: true }, "killSession"],
    ["Option+R", { code: "KeyR", key: "®", altKey: true }, "renameSession"],
    ["Option+[", { code: "BracketLeft", key: "“", altKey: true }, "navigateTab"],
    ["Option+]", { code: "BracketRight", key: "‘", altKey: true }, "navigateTab"],
    ["Option+1", { code: "Digit1", key: "¡", altKey: true }, "jumpToTab"],
    ["Option+5", { code: "Digit5", key: "∞", altKey: true }, "jumpToTab"],
  ];

  for (const [label, overrides, expectedAction] of realMacShapes) {
    it(`${label} (macOS Unicode ev.key) → ${expectedAction}`, () => {
      const r = decideAppKey(ev(overrides));
      assert.equal(r.action, expectedAction);
    });
  }
});

describe("isTextInputTarget", () => {
  // REGRESSION: xterm.js captures keystrokes via a hidden
  // <textarea class="xterm-helper-textarea">. When the terminal is
  // focused (the primary case users care about) document.activeElement
  // is that textarea. Treating it as a text input blocked EVERY Option
  // shortcut whenever the terminal was focused — Option+T wouldn't open
  // a new tab, Option+W wouldn't close, etc. This tripwire catches any
  // future refactor that strips the exemption.
  it("real text inputs return true", () => {
    assert.equal(isTextInputTarget({ tagName: "INPUT", classList: { contains: () => false } }), true);
    assert.equal(isTextInputTarget({ tagName: "TEXTAREA", classList: { contains: () => false } }), true);
    assert.equal(isTextInputTarget({ tagName: "DIV", isContentEditable: true, classList: { contains: () => false } }), true);
  });

  it("xterm-helper-textarea returns false (terminal focus shouldn't block shortcuts)", () => {
    const xtermTextarea = {
      tagName: "TEXTAREA",
      classList: {
        contains: (cls) => cls === "xterm-helper-textarea",
      },
    };
    assert.equal(isTextInputTarget(xtermTextarea), false);
  });

  it("non-input elements return false", () => {
    assert.equal(isTextInputTarget({ tagName: "DIV", classList: { contains: () => false } }), false);
    assert.equal(isTextInputTarget({ tagName: "BUTTON", classList: { contains: () => false } }), false);
  });

  it("null/undefined target returns false", () => {
    assert.equal(isTextInputTarget(null), false);
    assert.equal(isTextInputTarget(undefined), false);
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
