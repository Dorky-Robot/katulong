/**
 * Floating Action Buttons
 *
 * Vertical stack of circular buttons floating in the terminal pane:
 * Files, Settings, and a connection indicator dot at the bottom.
 * Visible on touch devices only.
 *
 * The feed button adapts to Claude presence. When the active tile's session
 * has `meta.claude.running` set by the server's pane monitor, the icon and
 * label swap to signal "this opens a Claude feed for *this* session."
 */

export function createJoystickManager(options = {}) {
  const joystick = document.getElementById("joystick");

  let _onFilesClick = null;
  let _onUploadClick = null;
  let _onSettingsClick = null;
  let _onFeedClick = null;
  let _claudeRunning = false;
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
    if (_onFeedClick) {
      const icon = _claudeRunning ? "sparkle" : "rss";
      const label = _claudeRunning ? "Claude feed" : "Feed";
      const cls = _claudeRunning ? "joystick-action-btn--claude" : "";
      joystick.appendChild(actionBtn(icon, label, _onFeedClick, cls));
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

  return {
    init() {
      // No gesture handling needed — just buttons
    },

    setActions({ onFilesClick, onUploadClick, onSettingsClick, onFeedClick }) {
      _onFilesClick = onFilesClick;
      _onUploadClick = onUploadClick;
      _onSettingsClick = onSettingsClick;
      _onFeedClick = onFeedClick;
      buildButtons();
    },

    /**
     * Update Claude-presence state for the active tile. Idempotent: callers
     * can invoke this on every `session-updated` broadcast without tearing
     * down the DOM when the state hasn't actually changed.
     */
    setClaudeRunning(running) {
      const next = !!running;
      if (_claudeRunning === next) return;
      _claudeRunning = next;
      buildButtons();
    },

    getState: () => ({ mode: 'idle', claudeRunning: _claudeRunning }),
  };
}
