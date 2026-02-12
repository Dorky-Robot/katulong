/**
 * Terminal Keyboard Handlers
 *
 * Composable keyboard event handlers for terminal input.
 */

/**
 * Create terminal keyboard handlers
 */
export function createTerminalKeyboard(options = {}) {
  const {
    term,
    onSend
  } = options;

  /**
   * Initialize Tab key interception
   * Prevents browser focus navigation and sends \t to PTY
   */
  function initTabHandler() {
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab" || ev.ctrlKey || ev.altKey || ev.metaKey) return;

      const active = document.activeElement;
      const inTerminal = active && (
        active.classList.contains("xterm-helper-textarea") ||
        active.closest("#terminal-container")
      );

      if (!inTerminal) return;

      ev.preventDefault();
      ev.stopPropagation();

      if (onSend) {
        onSend(ev.shiftKey ? "\x1b[Z" : "\t");
      }
    }, true); // Use capture phase
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

      // Shift+Enter: quoted-insert (\x16) + newline (\x0a)
      // Inserts a literal newline without executing (works in zsh/bash)
      if (ev.shiftKey && ev.key === "Enter" && ev.type === "keydown") {
        if (onSend) onSend("\x16\x0a");
        return false;
      }

      // Cmd/Meta key shortcuts
      if (ev.metaKey && ev.type === "keydown") {
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
          Backspace: "\x1b\x7f", // Alt+Backspace: delete word
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
   * Filters out focus-reporting sequences
   */
  function initDataHandler() {
    if (!term) return;

    term.onData((data) => {
      // Filter focus-reporting sequences (CSI I / CSI O) that xterm.js
      // emits when the browser tab gains/loses focus. These leak into
      // CLI apps like Claude Code as garbage input (issue #10375).
      const filtered = data
        .replace(/\x1b\[I/g, "")
        .replace(/\x1b\[O/g, "");

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
  }

  return {
    init,
    initTabHandler,
    initCustomKeyHandler,
    initDataHandler
  };
}
