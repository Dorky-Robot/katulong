/**
 * Viewport Manager
 *
 * Handles viewport resizing, scroll button UI, and terminal gesture handlers.
 */

import { withPreservedScroll } from "/lib/scroll-utils.js";

/**
 * Create viewport manager for responsive terminal layout
 */
export function createViewportManager(options = {}) {
  const {
    term,
    fit,
    termContainer,
    bar,
    onWebSocketResize,
    onDictationOpen
  } = options;

  // Scroll button elements
  const scrollBtn = document.getElementById("scroll-bottom");
  const viewport = document.querySelector(".xterm-viewport");

  // Resize viewport to match visual viewport (handles mobile keyboard)
  function resizeToViewport() {
    withPreservedScroll(term, () => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      bar.style.top = top + "px";
      termContainer.style.height = (h - 44) + "px";
      const s = document.documentElement.style;
      s.setProperty("--viewport-h", h + "px");
      s.setProperty("--viewport-top", top + "px");
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
  }

  // Initialize terminal ResizeObserver for WebSocket resize events
  function initTerminalResizeObserver() {
    const ro = new ResizeObserver(() => {
      withPreservedScroll(term, () => fit.fit());
      if (onWebSocketResize) {
        onWebSocketResize(term.cols, term.rows);
      }
    });
    ro.observe(termContainer);
    return ro;
  }

  // Initialize scroll-to-bottom button
  function initScrollButton() {
    if (!viewport || !scrollBtn) return;

    let scrollRaf = 0;
    viewport.addEventListener("scroll", () => {
      if (!scrollRaf) {
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          const atBottom = viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 10;
          scrollBtn.style.display = atBottom ? "none" : "flex";
        });
      }
    }, { passive: true });

    scrollBtn.addEventListener("click", () => {
      term.scrollToBottom(term);
      scrollBtn.style.display = "none";
    });
  }

  // Initialize terminal gesture handlers
  function initTerminalGestures() {
    // Focus terminal on tap
    termContainer.addEventListener("touchstart", () => term.focus(), { passive: true });

    // Long-press: native contextmenu event (fired by OS on long-press)
    termContainer.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (onDictationOpen) {
        onDictationOpen();
      }
    });
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
    resizeToViewport,
    initViewportResize,
    initTerminalResizeObserver,
    initScrollButton,
    initTerminalGestures
  };
}
