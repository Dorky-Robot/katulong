/**
 * Shortcut Bar Renderer
 *
 * Composable shortcut bar with session button, shortcuts, and files toggle.
 * P2P indicator and settings have moved to the sidebar footer.
 */

import { keysToSequence, sendSequence } from "/lib/key-mapping.js";

/**
 * Create shortcut bar renderer
 */
export function createShortcutBar(options = {}) {
  const {
    container,
    pinnedKeys = [
      { label: "Esc", keys: "esc" },
      { label: "Tab", keys: "tab" }
    ],
    onSessionClick,
    onNewSessionClick,
    onShortcutsClick,
    onFilesClick,
    sendFn,
    term,
    updateP2PIndicator,
    getInstanceIcon
  } = options;

  /**
   * Render the shortcut bar
   */
  function render(sessionName) {
    if (!container) return;

    container.innerHTML = "";

    // P2P indicator (hidden span — keeps the ID alive for P2P manager updates)
    const p2pDot = document.createElement("span");
    p2pDot.id = "p2p-indicator";
    p2pDot.style.display = "none";
    container.appendChild(p2pDot);

    // Update P2P indicator if callback provided
    if (updateP2PIndicator) updateP2PIndicator();

    // Session button
    const sessBtn = document.createElement("button");
    sessBtn.className = "session-btn";
    sessBtn.tabIndex = -1;
    sessBtn.setAttribute("aria-label", `Session: ${sessionName}`);
    const rawIcon = getInstanceIcon ? getInstanceIcon() : "terminal-window";
    const instanceIcon = rawIcon.replace(/[^a-z0-9-]/g, "");
    const iconEl = document.createElement("i");
    iconEl.className = `ph ph-${instanceIcon}`;
    sessBtn.appendChild(iconEl);
    sessBtn.appendChild(document.createTextNode(" "));
    sessBtn.appendChild(document.createTextNode(sessionName));
    if (onSessionClick) {
      sessBtn.addEventListener("click", onSessionClick);
    }
    container.appendChild(sessBtn);

    // New session button (visible on mobile only via CSS)
    const newSessBtn = document.createElement("button");
    newSessBtn.className = "bar-new-session-btn";
    newSessBtn.tabIndex = -1;
    newSessBtn.setAttribute("aria-label", "New session");
    newSessBtn.innerHTML = '<i class="ph ph-plus"></i>';
    if (onNewSessionClick) {
      newSessBtn.addEventListener("click", onNewSessionClick);
    }
    container.appendChild(newSessBtn);

    // Spacer
    const spacer = document.createElement("span");
    spacer.className = "bar-spacer";
    container.appendChild(spacer);

    // Pinned shortcut buttons
    for (const s of pinnedKeys) {
      const btn = document.createElement("button");
      btn.className = "shortcut-btn";
      btn.tabIndex = -1;
      btn.textContent = s.label;
      btn.setAttribute("aria-label", `Send ${s.label}`);
      btn.addEventListener("click", () => {
        if (sendFn) {
          sendSequence(keysToSequence(s.keys), sendFn);
        }
        if (term) term.focus();
      });
      container.appendChild(btn);
    }

    // Shortcuts button
    const kbBtn = document.createElement("button");
    kbBtn.className = "bar-icon-btn";
    kbBtn.tabIndex = -1;
    kbBtn.setAttribute("aria-label", "Open shortcuts");
    kbBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
    if (onShortcutsClick) {
      kbBtn.addEventListener("click", onShortcutsClick);
    }
    container.appendChild(kbBtn);

  }

  return {
    render
  };
}
