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

  // When true, we blocked a Ctrl+V keydown and are waiting for the
  // paste event (or fallback timer) to handle it.
  let _blocked = false;
  let _fallbackTimer = null;

  /**
   * Handle keydown — block Ctrl+V / Cmd+V so xterm doesn't send \x16
   * before the paste event fires.
   */
  function handleKeydown(e) {
    if ((e.key === "v" || e.key === "V") && (e.ctrlKey || e.metaKey) && !e.altKey) {
      // Don't intercept in regular input/textarea (except xterm's helper)
      const target = e.target;
      if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
          !target.classList.contains("xterm-helper-textarea")) {
        return;
      }
      _blocked = true;
      e.stopImmediatePropagation();
      e.preventDefault();
      // If no paste event fires within 200ms (WebKit suppresses it after
      // preventDefault on keydown), read the clipboard directly.
      _fallbackTimer = setTimeout(() => handleClipboardFallback(), 200);
    }
  }

  /**
   * Fallback: read clipboard via async Clipboard API when the paste event
   * doesn't fire (WebKit behavior after preventDefault on keydown).
   */
  async function handleClipboardFallback() {
    if (!_blocked) return;
    _blocked = false;
    _fallbackTimer = null;

    // Try navigator.clipboard.read() for images first
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const file = new File([blob], "clipboard-image." + type.split("/")[1], { type });
            if (isImageFileFn(file) && onImage) {
              onImage(file);
              return;
            }
          }
        }
      }
    } catch { /* Clipboard API read() not available or denied */ }

    // Fall back to reading text
    try {
      const text = await navigator.clipboard.readText();
      if (text && onTextPaste) { onTextPaste(text); return; }
    } catch { /* clipboard API not available */ }
  }

  /**
   * Handle paste event (fires on browsers that don't suppress it)
   */
  function handlePaste(e) {
    // Clear the fallback timer — paste event fired, so we handle it here
    if (_fallbackTimer) {
      clearTimeout(_fallbackTimer);
      _fallbackTimer = null;
    }
    _blocked = false;

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
      // Image paste — upload to host, which copies to host clipboard
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
    if (_fallbackTimer) {
      clearTimeout(_fallbackTimer);
      _fallbackTimer = null;
    }
  }

  return {
    init,
    unmount,
    handlePaste
  };
}
