/**
 * Shortcuts UI Components
 *
 * Handles shortcuts popup, edit panel, and add modal.
 */

import { removeShortcut, addShortcut } from '/lib/stores.js';

/**
 * Create shortcuts popup component
 */
export function createShortcutsPopup(options = {}) {
  const { onShortcutClick, modals } = options;

  return {
    render(container, shortcuts) {
      container.innerHTML = "";
      for (const s of shortcuts) {
        const btn = document.createElement("button");
        btn.className = "shortcut-btn";
        btn.setAttribute("role", "listitem");
        btn.textContent = s.label;
        btn.addEventListener("click", () => {
          if (onShortcutClick) onShortcutClick(s.keys);
          if (modals) modals.close('shortcuts');
        });
        container.appendChild(btn);
      }
    }
  };
}

/**
 * Create shortcuts edit panel component
 */
export function createShortcutsEditPanel(store, options = {}) {
  const { modals } = options;

  return {
    render(container, shortcuts) {
      container.innerHTML = "";
      shortcuts.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "edit-item";
        row.setAttribute("role", "listitem");

        const labelSpan = document.createElement("span");
        labelSpan.className = "edit-item-label";
        labelSpan.textContent = s.label;
        row.appendChild(labelSpan);

        const keysSpan = document.createElement("span");
        keysSpan.className = "edit-item-keys";
        keysSpan.textContent = s.keys;
        row.appendChild(keysSpan);

        const rm = document.createElement("button");
        rm.className = "edit-item-remove";
        rm.setAttribute("aria-label", `Remove ${s.label}`);
        rm.innerHTML = '<i class="ph ph-x"></i>';
        rm.addEventListener("click", () => {
          removeShortcut(store, i);
        });
        row.appendChild(rm);

        container.appendChild(row);
      });
    },

    open(shortcuts) {
      this.render(document.getElementById("edit-list"), shortcuts);
      if (modals) modals.open('edit');
    },

    close() {
      if (modals) modals.close('edit');
    }
  };
}

/**
 * Create add shortcut modal component
 */
export function createAddShortcutModal(store, options = {}) {
  const { modals, keysLabel, keysString, displayKey, normalizeKey, VALID_KEYS } = options;

  let composedKeys = [];

  const renderComposerTags = (keyComposer, keyInput, keyPreview, saveBtn, keys) => {
    keyComposer.querySelectorAll(".key-tag, .key-comma").forEach(t => t.remove());
    keys.forEach((k, i) => {
      if (k === ",") {
        const sep = document.createElement("span");
        sep.className = "key-comma";
        sep.textContent = ",";
        sep.addEventListener("click", () => {
          composedKeys = composedKeys.filter((_, idx) => idx !== i);
          renderComposerTags(keyComposer, keyInput, keyPreview, saveBtn, composedKeys);
        });
        keyComposer.insertBefore(sep, keyInput);
        return;
      }
      const tag = document.createElement("span");
      tag.className = "key-tag";
      tag.appendChild(document.createTextNode(displayKey(k)));
      const rmBtn = document.createElement("button");
      rmBtn.className = "key-tag-remove";
      rmBtn.setAttribute("aria-label", `Remove ${displayKey(k)}`);
      rmBtn.innerHTML = '<i class="ph ph-x"></i>';
      tag.appendChild(rmBtn);
      rmBtn.addEventListener("click", () => {
        composedKeys = composedKeys.filter((_, idx) => idx !== i);
        renderComposerTags(keyComposer, keyInput, keyPreview, saveBtn, composedKeys);
      });
      keyComposer.insertBefore(tag, keyInput);
    });
    keyPreview.textContent = keys.length > 0 ? keysLabel(keys) : "";
    saveBtn.disabled = keys.length === 0;
    keyInput.placeholder = keys.length ? "" : "type a key...";
  };

  return {
    init() {
      const keyComposer = document.getElementById("key-composer");
      const keyInput = document.getElementById("key-composer-input");
      const keyPreview = document.getElementById("key-preview-value");
      const saveBtn = document.getElementById("modal-save");

      keyComposer.addEventListener("click", () => keyInput.focus());

      keyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = keyInput.value.trim().toLowerCase();
          if (!val) return;
          if (VALID_KEYS.has(val)) {
            composedKeys = [...composedKeys, normalizeKey(val)];
            keyInput.value = "";
            renderComposerTags(keyComposer, keyInput, keyPreview, saveBtn, composedKeys);
          } else {
            keyComposer.classList.add("invalid");
            setTimeout(() => keyComposer.classList.remove("invalid"), 350);
          }
        } else if (e.key === "Backspace" && keyInput.value === "" && composedKeys.length > 0) {
          composedKeys = composedKeys.slice(0, -1);
          renderComposerTags(keyComposer, keyInput, keyPreview, saveBtn, composedKeys);
        }
      });

      document.getElementById("modal-cancel")?.addEventListener("click", () => {
        if (modals) modals.close('add');
      });

      document.getElementById("modal-save")?.addEventListener("click", () => {
        if (composedKeys.length === 0) return;
        addShortcut(store, {
          label: keysLabel(composedKeys),
          keys: keysString(composedKeys)
        });
        if (modals) modals.close('add');
      });
    },

    open() {
      const keyComposer = document.getElementById("key-composer");
      const keyInput = document.getElementById("key-composer-input");
      const keyPreview = document.getElementById("key-preview-value");
      const saveBtn = document.getElementById("modal-save");

      composedKeys = [];
      keyInput.value = "";
      renderComposerTags(keyComposer, keyInput, keyPreview, saveBtn, composedKeys);
      if (modals) modals.open('add');
    }
  };
}
