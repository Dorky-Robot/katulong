/**
 * Paste Handler
 *
 * Intercepts paste events for image uploads and text forwarding.
 *
 * Uses capture phase (third arg = true) so the handler fires before
 * xterm.js's bubble-phase handler calls stopPropagation().
 *
 * Also intercepts Ctrl+V/Cmd+V keydown to prevent xterm.js from sending
 * raw \x16 to the terminal before the paste event fires. This avoids a
 * race where CLI tools (Claude Code) read the clipboard before the image
 * has been uploaded and copied to the host clipboard.
 */

import { isImageFile } from "/lib/image-upload.js";

/**
 * Create paste handler
 */
export function createPasteHandler(options = {}) {
  const {
    onImage,
    onTextPaste,
    isImageFileFn = isImageFile
  } = options;

  /**
   * Handle keydown — block Ctrl+V / Cmd+V so xterm doesn't send \x16
   * before the paste event fires. We only use stopImmediatePropagation
   * (not preventDefault) so the browser still fires the paste event.
   */
  function handleKeydown(e) {
    if ((e.key === "v" || e.key === "V") && (e.ctrlKey || e.metaKey) && !e.altKey) {
      // Don't intercept in regular input/textarea (except xterm's helper)
      const target = e.target;
      if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
          !target.classList.contains("xterm-helper-textarea")) {
        return;
      }
      // Stop xterm's keydown handler from sending \x16, but do NOT
      // call preventDefault — that would suppress the paste event on WebKit.
      e.stopImmediatePropagation();
    }
  }

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

    // Check both files and items — Safari may only expose images via items
    let imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFileFn);
    if (imageFiles.length === 0 && e.clipboardData?.items) {
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file && isImageFileFn(file)) imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      // Image paste — upload to host, which sends the file path to terminal
      e.stopImmediatePropagation();
      e.preventDefault();
      if (onImage) {
        for (const file of imageFiles) {
          onImage(file);
        }
      }
    } else {
      const text = e.clipboardData?.getData("text/plain");
      e.stopImmediatePropagation();
      e.preventDefault();
      if (text && onTextPaste) {
        // Text paste — forward to terminal
        onTextPaste(text);
      }
      // If no text and no images, do nothing — the clipboard likely contains
      // an image that the browser can't access (e.g. iPad cross-app paste).
      // Sending \x16 would make CLI tools read a stale host clipboard.
    }
  }

  /**
   * Initialize paste handler (capture phase for both keydown and paste)
   */
  function init() {
    document.addEventListener("keydown", handleKeydown, true);
    document.addEventListener("paste", handlePaste, true);
  }

  /**
   * Cleanup
   */
  function unmount() {
    document.removeEventListener("keydown", handleKeydown, true);
    document.removeEventListener("paste", handlePaste, true);
  }

  return {
    init,
    unmount,
    handlePaste
  };
}
