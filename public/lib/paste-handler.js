/**
 * Paste Handler
 *
 * Capture-phase paste handler for images only.
 * Text paste is handled natively by xterm.js (bracket paste mode).
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

  // Flag: when true, we blocked a Ctrl+V keydown and are waiting
  // for the paste event to decide what to do.
  let _blocked = false;

  /**
   * Handle keydown — block Ctrl+V / Cmd+V so xterm doesn't send \x16
   * before the paste event fires. We'll handle it in handlePaste instead.
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
      // If no paste event fires within 200ms (e.g. empty clipboard),
      // send the original Ctrl+V through.
      setTimeout(() => {
        if (_blocked) {
          _blocked = false;
          if (onTextPaste) onTextPaste("\x16");
        }
      }, 200);
    }
  }

  /**
   * Handle paste event — images only
   */
  function handlePaste(e) {
    _blocked = false;

    // Let native paste work in input/textarea elements (e.g., dictation modal)
    // except for xterm's hidden textarea which we always intercept
    const target = e.target;
    if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
        !target.classList.contains("xterm-helper-textarea")) {
      return;
    }

    const imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFileFn);
    if (imageFiles.length > 0) {
      // Image paste — upload to host and send Ctrl+V after clipboard is set
      e.stopImmediatePropagation();
      e.preventDefault();
      if (onImage) {
        for (const file of imageFiles) {
          onImage(file);
        }
      }
    } else {
      // Text paste — we blocked the keydown, so forward text to terminal
      // Wrap in bracket paste sequences (\x1b[200~ ... \x1b[201~) so that
      // programs using bracket paste mode (zsh, vim, Claude Code) handle
      // multi-line pastes correctly.
      const text = e.clipboardData?.getData("text/plain");
      e.stopImmediatePropagation();
      e.preventDefault();
      if (text && onTextPaste) {
        onTextPaste(`\x1b[200~${text}\x1b[201~`);
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
  }

  return {
    init,
    unmount,
    handlePaste
  };
}
