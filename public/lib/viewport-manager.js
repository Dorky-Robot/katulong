/**
 * Viewport Manager
 *
 * Handles viewport resizing, scroll button UI, and terminal gesture handlers.
 */

import { isAtBottom, scrollToBottom } from "/lib/scroll-utils.js";

/**
 * Viewport Manager
 *
 * Handles CSS viewport variables (for modals during keyboard),
 * scroll-to-bottom button, and terminal touch-to-focus.
 */
export function createViewportManager(options = {}) {
  const { termContainer } = options;

  const getTerm = typeof options.term === "function" ? options.term : () => options.term;
  const scrollBtn = document.getElementById("scroll-bottom");

  // Update CSS custom properties for modal positioning when keyboard opens.
  // Layout height is handled by CSS 100dvh — no JS height manipulation needed.
  function resizeToViewport() {
    const vv = window.visualViewport;
    const h = (vv && vv.height > 0) ? vv.height : window.innerHeight;
    const s = document.documentElement.style;
    s.setProperty("--viewport-h", h + "px");
    s.setProperty("--viewport-top", (vv ? vv.offsetTop : 0) + "px");
  }

  // Initialize viewport resize handlers
  function initViewportResize() {
    resizeToViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", resizeToViewport);
      window.visualViewport.addEventListener("scroll", resizeToViewport);
    }
    window.addEventListener("resize", resizeToViewport);
    // Re-run after page load in case the visual viewport height was 0 during
    // the initial module execution (mobile Chromium emulation timing issue).
    window.addEventListener("load", resizeToViewport);
  }

  // --- Scroll-to-bottom button ---
  //
  // xterm.js 6 uses a custom scrollable element with its own scroll
  // management — native DOM scroll events do NOT fire on it. We must
  // use term.onScroll (fires when the viewport scroll offset changes)
  // and check the buffer's baseY vs viewportY to determine position.

  let _scrollDisposable = null; // xterm onScroll disposable

  function initScrollButton() {
    if (!scrollBtn) return;

    scrollBtn.addEventListener("click", () => {
      const term = getTerm();
      if (term) scrollToBottom(term);
      scrollBtn.style.display = "none";
    });
  }

  /**
   * Attach scroll-button tracking to the current terminal.
   *
   * Uses term.onScroll instead of DOM scroll events because xterm.js 6
   * uses a custom scrollable element that doesn't fire native scroll.
   *
   * Call whenever the active terminal changes. Safe to call repeatedly.
   */
  function attachScrollButton() {
    if (!scrollBtn) return;
    const term = getTerm();
    if (!term) return;

    // Dispose previous listener
    if (_scrollDisposable) {
      _scrollDisposable.dispose();
      _scrollDisposable = null;
    }

    _scrollDisposable = term.onScroll(() => {
      scrollBtn.style.display = isAtBottom(term) ? "none" : "flex";
    });

    // Also check on write completion — output may push baseY without
    // triggering onScroll if viewport was already following.
    // Initial state check:
    scrollBtn.style.display = isAtBottom(term) ? "none" : "flex";
  }

  // Initialize terminal gesture handlers
  function initTerminalGestures() {
    // Focus terminal on tap
    termContainer.addEventListener("touchstart", () => {
      const term = getTerm();
      if (term) term.focus();
    }, { passive: true });
  }

  // Initialize all viewport features
  function init() {
    initViewportResize();
    initScrollButton();
    initTerminalGestures();
  }

  return {
    init,
    attachScrollButton,
  };
}
