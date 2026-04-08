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
  const noop = (allowDefault) => ({ action: null, sequence: null, allowDefault });

  // Allow browser copy when text is selected
  if (ev.metaKey && ev.key === "c" && ctx.hasSelection) return noop(false);

  // Allow browser paste (handled by paste-handler at document level)
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "v") return noop(false);

  // Allow terminal Ctrl+C when no selection (sends SIGINT to PTY)
  if (ev.ctrlKey && ev.key === "c" && !ctx.hasSelection) return noop(true);

  // Tab handled by capture-phase listener — block xterm from also processing
  if (ev.key === "Tab") return noop(false);

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
    return noop(false);
  }

  // Cmd+/ — handled by app-level listener; block xterm so it doesn't see "/"
  if (ev.metaKey && ev.type === "keydown" && ev.key === "/") return noop(false);

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
      return noop(false);
    }

    // Terminal Option shortcuts — handled here
    if (ev.key === "f") return { action: "toggleSearch", sequence: null, allowDefault: false };
    if (ev.key === "k") return { action: "clearTerminal", sequence: null, allowDefault: false };

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

  return noop(true);
}
