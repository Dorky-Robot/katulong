/**
 * Floating Action Buttons
 *
 * Vertical stack of circular buttons floating in the terminal pane:
 * Files, Settings, and a connection indicator dot at the bottom.
 * Visible on touch devices only.
 */

export function createJoystickManager(options = {}) {
  const joystick = document.getElementById("joystick");

  let _onFilesClick = null;
  let _onSettingsClick = null;
  let dotEl = null;

  function buildButtons() {
    if (!joystick) return;
    joystick.innerHTML = "";

    function actionBtn(icon, label, handler) {
      const btn = document.createElement("button");
      btn.className = "joystick-action-btn";
      btn.innerHTML = `<i class="ph ph-${icon}"></i>`;
      btn.setAttribute("aria-label", label);
      btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); }, { capture: true });
      btn.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
      return btn;
    }

    if (_onFilesClick) {
      joystick.appendChild(actionBtn("folder-open", "Files", _onFilesClick));
    }
    if (_onSettingsClick) {
      joystick.appendChild(actionBtn("gear", "Settings", _onSettingsClick));
    }

    // Connection dot
    dotEl = document.createElement("div");
    dotEl.className = "joystick-dot";
    joystick.appendChild(dotEl);
  }

  return {
    init() {
      // No gesture handling needed — just buttons
    },

    setActions({ onFilesClick, onSettingsClick }) {
      _onFilesClick = onFilesClick;
      _onSettingsClick = onSettingsClick;
      buildButtons();
    },

    setConnected(connected) {
      if (dotEl) dotEl.classList.toggle("connected", connected);
    },

    getState: () => ({ mode: 'idle' })
  };
}
