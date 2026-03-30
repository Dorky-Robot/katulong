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
      btn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep keyboard open
      btn.addEventListener("click", () => {
        if (sendFn) sendSequence(keysToSequence(s.keys), sendFn);
      });
      row.appendChild(btn);
    }

    // Keyboard — opens inline text input
    {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.setAttribute("aria-label", "Type text");
      btn.innerHTML = '<i class="ph ph-keyboard"></i>';
      btn.addEventListener("click", () => {
        if (inputRow) {
          hideInlineInput();
          // Keep keyboard open by focusing the terminal
          const term = getTerm();
          if (term) term.focus();
        } else {
          showInlineInput();
        }
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

    if (parentEl) {
      const toolRow = parentEl.querySelector("#key-island");
      if (toolRow) {
        parentEl.insertBefore(inputRow, toolRow);
      } else {
        parentEl.appendChild(inputRow);
      }
    }

    requestAnimationFrame(() => input.focus());
  }

  function hideInlineInput() {
    if (!inputRow) return;
    inputRow.remove();
    inputRow = null;
  }

  // Spacer between touch keys and arrow keys
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  row.appendChild(spacer);

  // Arrow keys — hold to repeat, like holding a keyboard key
  if (platform !== "desktop") {
    const REPEAT_DELAY = 400; // ms before repeat starts
    const REPEAT_INTERVAL = 50; // ms between repeats

    for (const [icon, seq] of [
      ["caret-up", "\x1b[A"],
      ["caret-down", "\x1b[B"],
      ["caret-left", "\x1b[D"],
      ["caret-right", "\x1b[C"],
    ]) {
      const btn = document.createElement("button");
      btn.className = "key-island-btn key-island-icon";
      btn.innerHTML = `<i class="ph ph-${icon}"></i>`;

      let delayTimer = null;
      let repeatTimer = null;

      function startRepeat() {
        if (sendFn) sendFn(seq); // send immediately
        delayTimer = setTimeout(() => {
          repeatTimer = setInterval(() => { if (sendFn) sendFn(seq); }, REPEAT_INTERVAL);
        }, REPEAT_DELAY);
      }

      function stopRepeat() {
        if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
        if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
      }

      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // keep keyboard open
        startRepeat();
      });
      btn.addEventListener("pointerup", stopRepeat);
      btn.addEventListener("pointercancel", stopRepeat);
      btn.addEventListener("pointerleave", stopRepeat);

      row.appendChild(btn);
    }
  }

  // Append into parent (shortcut bar) instead of floating
  if (parentEl) {
    parentEl.appendChild(row);
  } else {
    document.body.appendChild(row);
  }
}
