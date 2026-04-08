/**
 * Terminal Keyboard Handlers
 *
 * Composable keyboard event handlers for terminal input. The pure
 * decision logic lives in `terminal-key-decider.js` so it can be unit
 * tested without xterm.js or DOM. This file is the imperative shell:
 * it wires the decision function to the term instance and to onSend.
 */

import { filterTerminalResponses, registerResponseSuppressors } from "/lib/terminal-input-filter.js";
import { decideTerminalKey } from "/lib/terminal-key-decider.js";

// Re-export so callers can import the decider through this module
// without knowing about the split.
export { decideTerminalKey };

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
   * Initialize custom key event handler.
   * Wires the pure decideTerminalKey function to the term instance.
   */
  function initCustomKeyHandler() {
    if (!term) return;

    term.attachCustomKeyEventHandler((ev) => {
      const decision = decideTerminalKey(ev, { hasSelection: term.hasSelection() });

      if (decision.sequence && onSend) {
        onSend(decision.sequence);
      }

      if (decision.action === "toggleSearch" && onToggleSearch) {
        ev.preventDefault?.();
        onToggleSearch();
      }

      if (decision.action === "clearTerminal") {
        term.clear();
      }

      return decision.allowDefault;
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
