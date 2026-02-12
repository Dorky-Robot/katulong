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
