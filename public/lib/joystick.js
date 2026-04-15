/**
 * Floating Action Buttons
 *
 * Vertical stack of circular buttons floating in the terminal pane:
 * Files, Settings, and a connection indicator dot at the bottom.
 *
 * The feed slot is contextual: it only renders when the active tile has a
 * detected context (e.g. `meta.claude` set by the server's pane monitor or
 * the SessionStart hook). When no context is active, the slot is hidden
 * entirely — the button is not greyed out, it simply does not exist.
 * Callers drive this via `setContext({ icon, label, className, action })`
 * or `setContext(null)` to hide.
 */

export function createJoystickManager(options = {}) {
  const joystick = document.getElementById("joystick");

  let _onFilesClick = null;
  let _onUploadClick = null;
  let _onSettingsClick = null;
  let _context = null;
  let dotEl = null;

  function buildButtons() {
    if (!joystick) return;
    joystick.innerHTML = "";

    function actionBtn(icon, label, handler, extraClass = "") {
      const btn = document.createElement("button");
      btn.className = `joystick-action-btn${extraClass ? " " + extraClass : ""}`;
      btn.innerHTML = `<i class="ph ph-${icon}"></i>`;
      btn.setAttribute("aria-label", label);
      btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); }, { capture: true });
      btn.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
      return btn;
    }

    if (_onUploadClick) {
      joystick.appendChild(actionBtn("image", "Upload image", _onUploadClick));
    }
    if (_onFilesClick) {
      joystick.appendChild(actionBtn("folder-open", "Files", _onFilesClick));
    }
    if (_context) {
      joystick.appendChild(actionBtn(_context.icon, _context.label, _context.action, _context.className || ""));
    }
    if (_onSettingsClick) {
      joystick.appendChild(actionBtn("gear", "Settings", _onSettingsClick));
    }

    // Connection dot — ID lets the connection subscriber in app.js target it
    dotEl = document.createElement("div");
    dotEl.className = "joystick-dot";
    dotEl.id = "joystick-connection-dot";
    joystick.appendChild(dotEl);
  }

  function contextEquals(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.icon === b.icon && a.label === b.label && (a.className || "") === (b.className || "");
  }

  return {
    init() {
      // No gesture handling needed — just buttons
    },

    setActions({ onFilesClick, onUploadClick, onSettingsClick }) {
      _onFilesClick = onFilesClick;
      _onUploadClick = onUploadClick;
      _onSettingsClick = onSettingsClick;
      buildButtons();
    },

    /**
     * Set the contextual slot for the active tile. Pass `null` to hide.
     * Idempotent: repeated calls with the same visual state skip the DOM
     * rebuild, so callers can invoke this on every `session-updated`
     * broadcast without churn.
     *
     * Context shape:
     *   { icon: "sparkle", label: "Claude feed",
     *     className: "joystick-action-btn--claude", action: () => ... }
     */
    setContext(context) {
      if (contextEquals(_context, context)) {
        // Action reference may have changed even if visuals match; update it
        // in place so clicks always invoke the latest closure.
        if (_context && context) _context.action = context.action;
        return;
      }
      _context = context;
      buildButtons();
    },

    getState: () => ({ mode: 'idle', context: _context }),
  };
}
