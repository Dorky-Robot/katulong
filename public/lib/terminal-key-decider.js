/**
 * Terminal Key Decision (pure)
 *
 * Pure decision function for keys that arrive at xterm via
 * attachCustomKeyEventHandler. Lives in its own file (no DOM imports)
 * so it can be unit-tested directly under Node.
 *
 * The full keyboard spec is pinned by test/keyboard-spec.test.js — keep
 * that file and the kb-help overlay in index.html in sync with any
 * change made here.
 */

/**
 * @param {KeyboardEvent} ev — DOM-shaped event with key/code/type/modifier flags
 * @param {object}        ctx — { hasSelection?: boolean }
 * @returns {{ action: string|null, sequence: string|null, allowDefault: boolean }}
 *   action       — symbolic name (clearTerminal, toggleSearch, …) or null
 *   sequence     — bytes to write to the PTY, or null
 *   allowDefault — return value for attachCustomKeyEventHandler.
 *                  true = let xterm process; false = block.
 */
export function decideTerminalKey(ev, ctx = {}) {
  const pass = (allowDefault) => ({ action: null, sequence: null, allowDefault });

  // Cmd+C with selection: block xterm so the browser's native copy
  // (which fires from the keydown event) is what handles the keystroke.
  // allowDefault=false here means "don't let xterm process" — the browser
  // copy still happens because we don't call ev.preventDefault().
  if (ev.metaKey && ev.key === "c" && ctx.hasSelection) return pass(false);

  // Cmd+V / Ctrl+V: same pattern. Block xterm; paste-handler.js intercepts
  // the resulting paste event at the document level for image bridging.
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "v") return pass(false);

  // Ctrl+C without selection: let xterm process so it sends SIGINT to PTY.
  if (ev.ctrlKey && ev.key === "c" && !ctx.hasSelection) return pass(true);

  // Tab handled by capture-phase listener — block xterm from also processing
  if (ev.key === "Tab") return pass(false);

  // Shift+Enter: send kitty CSI u sequence so modern TUI apps (Claude Code,
  // etc.) insert a literal newline instead of submitting.
  //
  // Must block ALL event types (keydown, keypress, keyup) — not just keydown.
  // xterm.js calls this handler for each event type. When _keyDown returns
  // early (custom handler → false), _keyDownHandled stays false. _keyPress
  // then checks _keyDownHandled, finds it false, and processes the keypress —
  // sending a raw \r that causes Claude Code to submit instead of inserting
  // a newline.
  if (ev.shiftKey && ev.key === "Enter") {
    if (ev.type === "keydown") {
      return { action: "kittyShiftEnter", sequence: "\x1b[13;2u", allowDefault: false };
    }
    return pass(false);
  }

  // Cmd+/ — must not leak to the PTY. If we only block keydown, xterm's
  // _keyDownHandled stays false and _keyPress reprocesses the keypress,
  // sending "/" to the shell. Block all event types for consistency.
  if (ev.metaKey && ev.key === "/") return pass(false);

  // Option (Alt) shortcuts.
  //
  // These keys must NOT leak to the PTY: xterm.js with macOptionIsMeta=true
  // would otherwise send ESC-prefixed sequences (e.g. \e1 for Option+1,
  // \er for Option+R) that trigger readline meta-commands in the shell.
  //
  // App-level Option keys (tab management, jump-to-tab, rename) are
  // handled in app-keyboard.js → decideAppKey. Here we just block them
  // from reaching the PTY.
  if (ev.altKey && !ev.metaKey && !ev.ctrlKey && ev.type === "keydown") {
    // App-level Option keys — blocked from PTY, action runs in app-keyboard
    if (
      ev.code === "KeyT" ||
      ev.code === "KeyW" ||
      ev.code === "KeyQ" ||
      ev.code === "KeyR" ||
      ev.code === "BracketLeft" ||
      ev.code === "BracketRight" ||
      /^Digit[0-9]$/.test(ev.code || "")
    ) {
      return pass(false);
    }

    // Terminal Option shortcuts — handled here.
    //
    // Must key off ev.code (physical key), NOT ev.key. With macOptionIsMeta,
    // macOS delivers Option+F as ev.key="ƒ" and Option+K as ev.key="˚" — the
    // Unicode characters produced by the Option layer. Checking ev.key === "f"
    // never matches and the shortcut silently dies. ev.code stays "KeyF" /
    // "KeyK" regardless of modifier or layout, which is why the app-level
    // Option block above also uses ev.code.
    if (ev.code === "KeyF") return { action: "toggleSearch", sequence: null, allowDefault: false };
    if (ev.code === "KeyK") return { action: "clearTerminal", sequence: null, allowDefault: false };

    // Line-editing sequences. macOS convention puts these on Cmd+arrow,
    // but Cmd+arrow is owned by the browser (history back/forward) inside
    // a PWA, so katulong moves them to Option+arrow. Word-back/word-forward
    // (\x1bb / \x1bf) is intentionally not bound — it conflicts with the
    // Option-owned line-nav and was unreachable in the previous code.
    // Users who need word-jump can rebind via the shortcut bar.
    const lineSeq = {
      Backspace: "\x15",   // delete to start of line
      ArrowLeft: "\x01",   // start of line
      ArrowRight: "\x05",  // end of line
    }[ev.key];
    if (lineSeq) {
      return { action: "lineEdit", sequence: lineSeq, allowDefault: false };
    }
  }

  return pass(true);
}
