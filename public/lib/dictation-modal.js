/**
 * Dictation Modal Component
 *
 * Handles text input with image attachments for terminal.
 */

import { createStore, createReducer } from '/lib/store.js';

const DICTATION_ACTIONS = {
  ADD_IMAGES: 'dictation/add-images',
  REMOVE_IMAGE: 'dictation/remove-image',
  CLEAR: 'dictation/clear'
};

const dictationReducer = createReducer([], {
  [DICTATION_ACTIONS.ADD_IMAGES]: (images, action) => {
    return [...images, ...action.files];
  },
  [DICTATION_ACTIONS.REMOVE_IMAGE]: (images, action) => {
    return images.filter((_, idx) => idx !== action.index);
  },
  [DICTATION_ACTIONS.CLEAR]: () => {
    return [];
  }
});

/**
 * Create dictation modal component
 */
export function createDictationModal(options = {}) {
  const { modals, onSend } = options;
  const store = createStore([], dictationReducer, { debug: false });

  function revokeAllThumbs(container) {
    for (const img of container.querySelectorAll("img")) {
      URL.revokeObjectURL(img.src);
    }
  }

  const renderThumbs = (container, images) => {
    revokeAllThumbs(container);
    container.innerHTML = "";
    images.forEach((file, i) => {
      const wrap = document.createElement("div");
      wrap.className = "dictation-thumb";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      wrap.appendChild(img);
      const rm = document.createElement("button");
      rm.className = "dictation-thumb-remove";
      rm.setAttribute("aria-label", `Remove ${file.name}`);
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", () => {
        store.dispatch({ type: DICTATION_ACTIONS.REMOVE_IMAGE, index: i });
      });
      wrap.appendChild(rm);
      container.appendChild(wrap);
    });
  };

  // Subscribe to image changes
  store.subscribe((images) => {
    const container = document.getElementById("dictation-thumbs");
    if (container) {
      renderThumbs(container, images);
    }
  });

  return {
    init() {
      const fileInput = document.getElementById("dictation-file-input");
      const sendBtn = document.getElementById("dictation-send");

      if (fileInput) {
        fileInput.addEventListener("change", () => {
          const files = [...fileInput.files].filter(f => f.type.startsWith("image/"));
          store.dispatch({ type: DICTATION_ACTIONS.ADD_IMAGES, files });
          fileInput.value = "";
        });
      }

      // Handle image paste into the textarea
      const textInput = document.getElementById("dictation-input");
      if (textInput) {
        textInput.addEventListener("paste", (e) => {
          // Check both files and items — Safari may only expose images via items
          let imageFiles = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
          if (imageFiles.length === 0 && e.clipboardData?.items) {
            for (const item of e.clipboardData.items) {
              if (item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) imageFiles.push(file);
              }
            }
          }
          if (imageFiles.length > 0) {
            e.preventDefault();
            store.dispatch({ type: DICTATION_ACTIONS.ADD_IMAGES, files: imageFiles });
          }
        });
      }

      if (sendBtn) {
        sendBtn.addEventListener("click", async () => {
          const textInput = document.getElementById("dictation-input");
          const text = textInput?.value || "";
          const images = [...store.getState()];
          this.close();
          if (onSend) {
            await onSend(text, images);
          }
        });
      }
    },

    open() {
      const textInput = document.getElementById("dictation-input");
      if (textInput) {
        textInput.value = "";
      }
      store.dispatch({ type: DICTATION_ACTIONS.CLEAR });
      if (modals) {
        modals.open('dictation');
      }
      if (textInput) {
        textInput.focus();
      }
    },

    close() {
      const textInput = document.getElementById("dictation-input");
      if (textInput) {
        textInput.value = "";
      }
      store.dispatch({ type: DICTATION_ACTIONS.CLEAR });
      if (modals) {
        modals.close('dictation');
      }
    }
  };
}
