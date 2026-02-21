/**
 * Paste Handler
 *
 * Composable clipboard paste handler for text and images.
 */

import { isImageFile } from "/lib/image-upload.js";

/**
 * Create paste handler
 */
export function createPasteHandler(options = {}) {
  const {
    onText,
    onImage,
    isImageFileFn = isImageFile
  } = options;

  /**
   * Handle paste event
   */
  function handlePaste(e) {
    // Let native paste work in input/textarea elements (e.g., dictation modal)
    // except for xterm's hidden textarea which we always intercept
    const target = e.target;
    if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
        !target.classList.contains("xterm-helper-textarea")) {
      return;
    }

    // Check for pasted images first (e.g., screenshots)
    const imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFileFn);
    if (imageFiles.length > 0) {
      e.preventDefault();
      if (onImage) {
        for (const file of imageFiles) {
          onImage(file);
        }
      }
      return;
    }

    // Handle text paste
    const text = e.clipboardData?.getData("text");
    if (text) {
      e.preventDefault();
      if (onText) onText(text);
    }
  }

  /**
   * Initialize paste handler
   */
  function init() {
    document.addEventListener("paste", handlePaste);
  }

  /**
   * Cleanup
   */
  function unmount() {
    document.removeEventListener("paste", handlePaste);
  }

  return {
    init,
    unmount,
    handlePaste
  };
}
