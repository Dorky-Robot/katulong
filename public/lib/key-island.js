/**
 * Tool Row — Second row of the bottom bar with Esc/Tab/keyboard
 * for touch devices, plus utility buttons (files, settings) on all platforms.
 *
 * Docked inside #shortcut-bar as a second row, not a floating island.
 */

import { keysToSequence, sendSequence } from "/lib/key-mapping.js";

/**
 * Render the tool row inside the shortcut bar.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.parentEl - Container to append into (the shortcut bar)
 * @param {string} opts.platform - "desktop" | "ipad" | "phone"
 * @param {Array}  opts.pinnedKeys - Array of { label, keys } objects
 * @param {Function} opts.sendFn - Function to send terminal input
 * @param {Function} opts.getTerm - Returns the xterm Terminal instance
 * @param {Object}  [opts.terminalPool] - Terminal pool (for openKeyboard)
 * @param {Function} [opts.onShortcutsClick]
 * @param {Function} [opts.onFilesClick]
 * @param {Function} [opts.onSettingsClick]
 * @param {boolean}  opts.portProxyEnabled
 * @param {Array}    [opts.pluginButtons] - Array of { icon, label, click }
 */
export function renderKeyIsland(opts) {
  const {
    parentEl,
    platform,
    pinnedKeys,
    sendFn,
    getTerm,
    onShortcutsClick,
    onFilesClick,
    onSettingsClick,
    pluginButtons,
  } = opts;

  // Remove previous tool row
  document.getElementById("key-island")?.remove();

  const row = document.createElement("div");
  row.id = "key-island";

  // Pinned keys — touch only (desktop has real keyboard)
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
      row.appendChild(btn);
    }

    // Keyboard — opens inline text input
    {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Type text");
      btn.innerHTML = '<i class="ph ph-keyboard"></i>';
      btn.addEventListener("click", () => showInlineInput());
      row.appendChild(btn);
    }

    // Attach image
    {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Attach image");
      btn.innerHTML = '<i class="ph ph-image"></i>';
      btn.addEventListener("click", () => {
        const fileInput = document.getElementById("dictation-file-input");
        if (fileInput) fileInput.click();
      });
      row.appendChild(btn);
    }

    if (onShortcutsClick) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Shortcuts");
      btn.innerHTML = '<i class="ph ph-command"></i>';
      btn.addEventListener("click", onShortcutsClick);
      row.appendChild(btn);
    }
  }

  // --- Inline text input (appears between tab row and tool row) ---
  let inputRow = null;
  let vpHandler = null;

  function showInlineInput() {
    if (inputRow) return;

    inputRow = document.createElement("div");
    inputRow.className = "bar-input-row";

    const input = document.createElement("div");
    input.className = "bar-inline-input";
    input.contentEditable = "plaintext-only";
    input.setAttribute("role", "textbox");
    input.setAttribute("enterkeyhint", "send");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("autocorrect", "off");
    input.dataset.placeholder = "type...";

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.textContent;
        if (sendFn) {
          sendFn(text ? text + "\r" : "\r");
        }
        input.textContent = "";
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideInlineInput();
      }
      e.stopPropagation();
    });

    inputRow.appendChild(input);

    // Insert before the tool row (#key-island itself = this row's parent sibling)
    // The inputRow goes between .bar-tab-row and #key-island
    if (parentEl) {
      const toolRow = parentEl.querySelector("#key-island");
      if (toolRow) {
        parentEl.insertBefore(inputRow, toolRow);
      } else {
        parentEl.appendChild(inputRow);
      }
    }

    // Focus after DOM insertion
    requestAnimationFrame(() => input.focus());

    // Resize the app to fit the visual viewport when keyboard opens.
    // This keeps the terminal visible above the bar + keyboard without
    // flying off screen. The bar is at the bottom of the flex layout,
    // so shrinking the container height naturally pushes it up.
    const appEl = document.querySelector("body");
    if (window.visualViewport && appEl) {
      vpHandler = () => {
        const vpH = window.visualViewport.height;
        appEl.style.height = vpH + "px";
        appEl.style.overflow = "hidden";
      };
      vpHandler(); // apply immediately
      window.visualViewport.addEventListener("resize", vpHandler);
    }

    // Hide on blur (keyboard dismiss)
    input.addEventListener("blur", () => {
      // Small delay so "Send" tap can fire before we remove the input
      setTimeout(() => hideInlineInput(), 150);
    });
  }

  function hideInlineInput() {
    if (!inputRow) return;
    inputRow.remove();
    inputRow = null;
    // Reset body height
    const appEl = document.querySelector("body");
    if (appEl) {
      appEl.style.height = "";
      appEl.style.overflow = "";
    }
    if (vpHandler && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", vpHandler);
      vpHandler = null;
    }
  }

  // Expose for the joystick action button
  if (typeof window !== "undefined") {
    window._showInlineInput = showInlineInput;
  }

  // Spacer pushes utility buttons to the right
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  row.appendChild(spacer);

  // Utility buttons — all platforms
  if (onFilesClick) {
    const btn = document.createElement("button");
    btn.className = "key-island-btn key-island-icon";
    btn.setAttribute("aria-label", "Files");
    btn.innerHTML = '<i class="ph ph-folder-open"></i>';
    btn.addEventListener("click", onFilesClick);
    row.appendChild(btn);
  }

  // Plugin buttons
  for (const p of (pluginButtons || [])) {
    if (!p.click) continue;
    const btn = document.createElement("button");
    btn.className = "key-island-btn key-island-icon";
    btn.setAttribute("aria-label", p.label);
    btn.innerHTML = `<i class="ph ph-${p.icon}"></i>`;
    btn.addEventListener("click", p.click);
    row.appendChild(btn);
  }

  if (onSettingsClick) {
    const btn = document.createElement("button");
    btn.className = "key-island-btn key-island-icon";
    btn.setAttribute("aria-label", "Settings");
    btn.innerHTML = '<i class="ph ph-gear"></i>';
    btn.addEventListener("click", onSettingsClick);
    row.appendChild(btn);
  }

  // Connection dot
  const dot = document.createElement("span");
  dot.id = "island-connection-dot";
  dot.className = "island-connection-dot";
  row.appendChild(dot);

  // Append into parent (shortcut bar) instead of floating
  if (parentEl) {
    parentEl.appendChild(row);
  } else {
    document.body.appendChild(row);
  }
}
