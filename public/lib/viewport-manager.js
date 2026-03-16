/**
 * Viewport Manager
 *
 * Handles viewport resizing, scroll button UI, and terminal gesture handlers.
 */

import { withPreservedScroll, viewportOf, isAtBottom, scrollToBottom } from "/lib/scroll-utils.js";

/**
 * Create viewport manager for responsive terminal layout
 */
export function createViewportManager(options = {}) {
  const {
    termContainer,
    bar,
    onWebSocketResize,
  } = options;

  // Support both direct references and getter functions for pooled terminals
  const getTerm = typeof options.term === "function" ? options.term : () => options.term;
  const getFit = typeof options.fit === "function" ? options.fit : () => options.fit;

  // Scroll button elements
  const scrollBtn = document.getElementById("scroll-bottom");
  const getViewport = () => { const t = getTerm(); return t ? viewportOf(t) : null; };

  const appLayout = document.getElementById("app-layout");

  // Resize viewport to match visual viewport (handles mobile keyboard)
  function resizeToViewport() {
    const term = getTerm();
    if (!term) return;
    withPreservedScroll(term, () => {
      const vv = window.visualViewport;
      // In Chromium mobile emulation (isMobile: true), vv.height can be 0 during
      // initial JS module execution before the visual viewport is fully initialised.
      // Fall back to window.innerHeight so the terminal container gets a valid height.
      const vvH = (vv && vv.height > 0) ? vv.height : window.innerHeight;
      const innerH = window.innerHeight;
      // Only override layout height when a keyboard or similar input is shrinking
      // the visual viewport (vv.height significantly less than innerHeight).
      // Otherwise let CSS 100dvh handle layout — this avoids a gap on iPad
      // where the floating toolbar reduces visualViewport.height but the app
      // should still fill the full screen.
      const keyboardOpen = innerH - vvH > 100;
      const h = keyboardOpen ? vvH : innerH;
      const layoutHeight = h + "px";
      if (appLayout) {
        appLayout.style.height = layoutHeight;
      } else {
        termContainer.style.height = layoutHeight;
      }
      const s = document.documentElement.style;
      s.setProperty("--viewport-h", h + "px");
      s.setProperty("--viewport-top", (vv ? vv.offsetTop : 0) + "px");
    });
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

  // Flag to suppress resize echo when applying server-dictated dimensions
  let isSyncResize = false;

  // Initialize terminal ResizeObserver for WebSocket resize events
  function initTerminalResizeObserver() {
    const ro = new ResizeObserver(() => {
      // Skip when terminal is hidden (e.g. file browser is active).
      // fit.fit() on a display:none element produces 0 dimensions which
      // corrupts the PTY session via an invalid resize message.
      if (termContainer.offsetParent === null) return;
      // Skip if this resize was triggered by a server resize-sync message
      if (isSyncResize) return;
      const term = getTerm();
      const fit = getFit();
      if (!term || !fit) return;
      withPreservedScroll(term, () => fit.fit());
      if (onWebSocketResize) {
        onWebSocketResize(term.cols, term.rows);
      }
    });
    ro.observe(termContainer);
    return ro;
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
    const resizeObserver = initTerminalResizeObserver();
    initScrollButton();
    initTerminalGestures();
    return resizeObserver;
  }

  return {
    init,
    attachScrollButton,
    resizeToViewport,
    initViewportResize,
    initTerminalResizeObserver,
    initScrollButton,
    initTerminalGestures,
    setSyncResize(v) { isSyncResize = v; },
  };
}
