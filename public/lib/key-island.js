/**
 * Key Island — Floating pill with Esc/Tab/keyboard for touch devices,
 * plus utility buttons (files, port-forward, settings) on tablet/desktop.
 *
 * Extracted from shortcut-bar.js for modularity.
 */

import { keysToSequence, sendSequence } from "/lib/key-mapping.js";

let _islandResizeHandler = null;

/**
 * Render the floating key island.
 *
 * @param {Object} opts
 * @param {string} opts.platform - "desktop" | "ipad" | "phone"
 * @param {Array}  opts.pinnedKeys - Array of { label, keys } objects
 * @param {Function} opts.sendFn - Function to send terminal input
 * @param {Function} opts.getTerm - Returns the xterm Terminal instance
 * @param {Function} [opts.onShortcutsClick]
 * @param {Function} [opts.onDictationClick]
 * @param {Function} [opts.onNotepadClick]
 * @param {Function} [opts.onFilesClick]
 * @param {Function} [opts.onPortForwardClick]
 * @param {Function} [opts.onSettingsClick]
 * @param {boolean}  opts.portProxyEnabled
 * @param {Array}    [opts.pluginButtons] - Array of { icon, label, click }
 */
export function renderKeyIsland(opts) {
  const {
    platform,
    pinnedKeys,
    sendFn,
    getTerm,
    onShortcutsClick,
    onDictationClick,
    onNotepadClick,
    onFilesClick,
    onPortForwardClick,
    onSettingsClick,
    portProxyEnabled,
    pluginButtons,
  } = opts;

  // Remove previous island and its resize listeners
  document.getElementById("key-island")?.remove();
  if (_islandResizeHandler) {
    window.removeEventListener("resize", _islandResizeHandler);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", _islandResizeHandler);
    }
    _islandResizeHandler = null;
  }

  const island = document.createElement("div");
  island.id = "key-island";

  // Pinned keys and keyboard shortcut button — touch only (desktop has real keyboard)

  if (platform !== "desktop") {
    for (const s of pinnedKeys) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn";
      btn.textContent = s.label;
      btn.setAttribute("aria-label", `Send ${s.label}`);
      btn.addEventListener("click", () => {
        if (sendFn) sendSequence(keysToSequence(s.keys), sendFn);
        const term = getTerm();
        if (term) term.focus();
      });
      island.appendChild(btn);
    }

    // Copy button — copies xterm selection to clipboard (iOS can't copy
    // canvas-based selection via the native context menu)
    {
      const copyBtn = document.createElement("button");
      copyBtn.className = "key-island-btn key-island-icon";
      copyBtn.setAttribute("aria-label", "Copy selection");
      copyBtn.innerHTML = '<i class="ph ph-copy"></i>';
      copyBtn.addEventListener("click", () => {
        const term = getTerm();
        if (term && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).then(() => {
            copyBtn.innerHTML = '<i class="ph ph-check"></i>';
            setTimeout(() => { copyBtn.innerHTML = '<i class="ph ph-copy"></i>'; }, 1000);
          }).catch(() => {});
        }
        if (term) term.focus();
      });
      island.appendChild(copyBtn);
    }

    if (onShortcutsClick) {
      const kbBtn = document.createElement("button");
      kbBtn.className = "key-island-btn key-island-icon";
      kbBtn.setAttribute("aria-label", "Open shortcuts");
      kbBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
      kbBtn.addEventListener("click", onShortcutsClick);
      island.appendChild(kbBtn);
    }

    if (onDictationClick) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Text input");
      btn.innerHTML = '<i class="ph ph-chat-text"></i>';
      btn.addEventListener("click", onDictationClick);
      island.appendChild(btn);
    }
  }

  // Utility buttons — skip on phone (they're in the toolbar)
  if (platform !== "phone") {
    if (onNotepadClick) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Notes");
      btn.innerHTML = '<i class="ph ph-note-pencil"></i>';
      btn.addEventListener("click", onNotepadClick);
      island.appendChild(btn);
    }

    if (onFilesClick) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Files");
      btn.innerHTML = '<i class="ph ph-folder-open"></i>';
      btn.addEventListener("click", onFilesClick);
      island.appendChild(btn);
    }

    if (onPortForwardClick) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.id = "bar-portfwd-btn";
      btn.setAttribute("aria-label", "Port Forward");
      btn.innerHTML = '<i class="ph ph-plug"></i>';
      btn.addEventListener("click", onPortForwardClick);
      if (!portProxyEnabled) btn.style.display = "none";
      island.appendChild(btn);
    }

    // Plugin buttons
    for (const p of (pluginButtons || [])) {
      if (!p.click) continue;
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", p.label);
      btn.innerHTML = `<i class="ph ph-${p.icon}"></i>`;
      btn.addEventListener("click", p.click);
      island.appendChild(btn);
    }

    if (onSettingsClick) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Settings");
      btn.innerHTML = '<i class="ph ph-gear"></i>';
      btn.addEventListener("click", onSettingsClick);
      island.appendChild(btn);
    }

  }

  // Connection dot — shown on all devices
  const dot = document.createElement("span");
  dot.id = "island-connection-dot";
  dot.className = "island-connection-dot";
  island.appendChild(dot);

  // Clamp island position to stay within viewport (with 8px margin)
  function clampIsland() {
    const rect = island.getBoundingClientRect();
    if (rect.width === 0) return; // not visible yet
    const margin = 8;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    // If fully visible with margin, nothing to do
    if (rect.left >= margin && rect.top >= margin &&
        rect.right <= vw - margin && rect.bottom <= vh - margin) return;
    // Nudge into view
    const nx = Math.max(margin, Math.min(rect.left, vw - rect.width - margin));
    const ny = Math.max(margin, Math.min(rect.top, vh - rect.height - margin));
    island.style.left = nx + "px";
    island.style.top = ny + "px";
    island.style.bottom = "auto";
    island.style.right = "auto";
    localStorage.setItem("katulong-key-island-pos", JSON.stringify({ x: nx, y: ny }));
  }

  // Restore saved position (clamped to current viewport)
  const saved = localStorage.getItem("katulong-key-island-pos");
  if (saved) {
    try {
      const { x, y } = JSON.parse(saved);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        island.style.left = x + "px";
        island.style.top = y + "px";
        island.style.bottom = "auto";
      }
    } catch {}
  }

  // Clamp after layout (when dimensions are known) and on every resize
  _islandResizeHandler = clampIsland;
  requestAnimationFrame(() => clampIsland());
  window.addEventListener("resize", clampIsland);
  // Also observe the visual viewport (fires more reliably on iOS/iPad)
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", clampIsland);
  }

  // Drag to reposition (touch + mouse, with dead zone so clicks/taps still work)
  let dragState = null;

  function islandDragMove(cx, cy) {
    if (!dragState) return;
    if (!dragState.dragging) {
      const dx = cx - dragState.startX;
      const dy = cy - dragState.startY;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      dragState.dragging = true;
    }
    const x = cx - dragState.offsetX;
    const y = cy - dragState.offsetY;
    const margin = 8;
    const maxX = (window.visualViewport?.width ?? window.innerWidth) - island.offsetWidth - margin;
    const maxY = (window.visualViewport?.height ?? window.innerHeight) - island.offsetHeight - margin;
    island.style.left = Math.max(margin, Math.min(x, maxX)) + "px";
    island.style.top = Math.max(margin, Math.min(y, maxY)) + "px";
    island.style.bottom = "auto";
    island.style.right = "auto";
  }

  function islandDragEnd() {
    if (dragState?.dragging) {
      localStorage.setItem("katulong-key-island-pos", JSON.stringify({
        x: parseInt(island.style.left),
        y: parseInt(island.style.top),
      }));
    }
    dragState = null;
  }

  // Touch drag (skip if tapping the connection dot or a button)
  island.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest("button")) return;
    const t = e.touches[0];
    const rect = island.getBoundingClientRect();
    dragState = { startX: t.clientX, startY: t.clientY, offsetX: t.clientX - rect.left, offsetY: t.clientY - rect.top, dragging: false };
  }, { passive: false });
  island.addEventListener("touchmove", (e) => {
    if (!dragState) return;
    const t = e.touches[0];
    islandDragMove(t.clientX, t.clientY);
    if (dragState?.dragging) { e.preventDefault(); e.stopPropagation(); }
  }, { passive: false });
  island.addEventListener("touchend", (e) => {
    if (dragState?.dragging) e.preventDefault();
    islandDragEnd();
  });

  // Mouse drag
  island.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return; // let button clicks through
    const rect = island.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, dragging: false };
    const onMouseMove = (me) => {
      islandDragMove(me.clientX, me.clientY);
      if (dragState?.dragging) { me.preventDefault(); }
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      islandDragEnd();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  document.body.appendChild(island);
}
