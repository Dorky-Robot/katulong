/**
 * Paste Handler
 *
 * Capture-phase paste handler for images only.
 * Text paste is handled natively by xterm.js (bracket paste mode).
 *
 * Uses capture phase (third arg = true) so the handler fires before
 * xterm.js's bubble-phase handler calls stopPropagation().
 */

import { isImageFile } from "/lib/image-upload.js";

/**
 * Create paste handler
 */
export function createPasteHandler(options = {}) {
  const {
    onImage,
    isImageFileFn = isImageFile
  } = options;

  /**
   * Handle paste event — images only
   */
  function handlePaste(e) {
    // Let native paste work in input/textarea elements (e.g., dictation modal)
    // except for xterm's hidden textarea which we always intercept
    const target = e.target;
    if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
        !target.classList.contains("xterm-helper-textarea")) {
      return;
    }

    // Only intercept image pastes — let xterm handle text natively
    const imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFileFn);
    if (imageFiles.length > 0) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (onImage) {
        for (const file of imageFiles) {
          onImage(file);
        }
      }
    }
  }

  /**
   * Initialize paste handler (capture phase)
   */
  function init() {
    document.addEventListener("paste", handlePaste, true);
  }

  /**
   * Cleanup
   */
  function unmount() {
    document.removeEventListener("paste", handlePaste, true);
  }

  return {
    init,
    unmount,
    handlePaste
  };
}
