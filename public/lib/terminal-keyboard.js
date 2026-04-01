/**
 * Terminal Keyboard Handlers
 *
 * Composable keyboard event handlers for terminal input.
 */

import { filterTerminalResponses, registerResponseSuppressors } from "/lib/terminal-input-filter.js";

/**
 * Create terminal keyboard handlers
 */
export function createTerminalKeyboard(options = {}) {
  const {
    term,
    onSend,
    onToggleSearch
  } = options;

  /**
   * Initialize Tab key interception
   * Prevents browser focus navigation and sends \t to PTY
   */
  let _tabHandler = null;

  function initTabHandler() {
    // Guard: only register one document-level Tab handler per terminal.
    // The handler checks that THIS terminal's textarea is focused before
    // sending, so multiple terminals in the pool don't double-fire.
    if (_tabHandler) return;
    _tabHandler = (ev) => {
      if (ev.key !== "Tab" || ev.ctrlKey || ev.altKey || ev.metaKey) return;

      // Only handle if THIS terminal's helper textarea is focused
      const active = document.activeElement;
      if (!active) return;
      const textarea = term?.element?.querySelector(".xterm-helper-textarea");
      if (active !== textarea) return;

      ev.preventDefault();
      ev.stopPropagation();

      if (onSend) {
        onSend(ev.shiftKey ? "\x1b[Z" : "\t");
      }
    };
    document.addEventListener("keydown", _tabHandler, true);
  }

  /**
   * Initialize custom key event handler
   * Handles special key combinations and shortcuts
   */
  function initCustomKeyHandler() {
    if (!term) return;

    term.attachCustomKeyEventHandler((ev) => {
      // Allow browser copy when text is selected
      if (ev.metaKey && ev.key === "c" && term.hasSelection()) return false;

      // Allow browser paste
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "v") return false;

      // Allow terminal Ctrl+C when no selection
      if (ev.ctrlKey && ev.key === "c" && !term.hasSelection()) return true;

      // Tab handled by capture-phase listener
      if (ev.key === "Tab") return false;

      // Shift+Enter: send kitty keyboard protocol CSI u sequence.
      // Encodes key=13 (Enter) with modifier=2 (Shift) → \x1b[13;2u.
      // Claude Code (and other modern TUI apps) recognise this as
      // Shift+Enter and insert a literal newline instead of submitting.
      // xterm.js doesn't natively support kitty keyboard, so we send
      // the sequence manually via the PTY.
      //
      // Must block ALL event types (keydown, keypress, keyup) — not just
      // keydown. xterm.js calls this handler for each event type. When
      // _keyDown returns early (custom handler → false), _keyDownHandled
      // stays false. _keyPress then checks _keyDownHandled, finds it
      // false, and processes the keypress — sending a raw \r that causes
      // Claude Code to submit instead of inserting a newline.
      if (ev.shiftKey && ev.key === "Enter") {
        if (ev.type === "keydown" && onSend) onSend("\x1b[13;2u");
        return false;
      }

      // Cmd/Meta key shortcuts
      if (ev.metaKey && ev.type === "keydown") {
        // App-level shortcuts — handled by app-level listener, don't send to PTY
        if (ev.key === "[" || ev.key === "]" || ev.key === "/" ||
            ev.key === "{" || ev.key === "}" ||
            ev.key === "t" || ev.key === "w") return false;

        if (ev.key === "f" && onToggleSearch) {
          ev.preventDefault();
          onToggleSearch();
          return false;
        }
        if (ev.key === "k") {
          term.clear();
          return false;
        }

        const metaSeq = {
          Backspace: "\x15",     // Cmd+Backspace: delete line
          ArrowLeft: "\x01",     // Cmd+Left: start of line
          ArrowRight: "\x05"     // Cmd+Right: end of line
        }[ev.key];

        if (metaSeq && onSend) {
          onSend(metaSeq);
          return false;
        }
      }

      // Alt/Option key shortcuts
      if (ev.altKey && ev.type === "keydown") {
        const altSeq = {
          ArrowLeft: "\x1bb",    // Alt+Left: word back
          ArrowRight: "\x1bf"    // Alt+Right: word forward
        }[ev.key];

        if (altSeq && onSend) {
          onSend(altSeq);
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Initialize terminal data handler
   * Filters out terminal query responses that xterm.js emits via onData
   */
  function initDataHandler() {
    if (!term) return;

    term.onData((data) => {
      const filtered = filterTerminalResponses(data);
      if (filtered && onSend) {
        onSend(filtered);
      }
    });
  }

  /**
   * Initialize all keyboard handlers
   */
  function init() {
    initTabHandler();
    initCustomKeyHandler();
    initDataHandler();
    // Suppress OSC color query responses at the parser level
    if (term) registerResponseSuppressors(term);
  }

  return {
    init,
    initTabHandler,
    initCustomKeyHandler,
    initDataHandler
  };
}
