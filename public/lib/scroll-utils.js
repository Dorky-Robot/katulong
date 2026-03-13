/**
 * Scroll State Utilities
 *
 * Composable scroll management helpers for terminal.
 */

/** Derive the viewport element from a terminal instance's own DOM */
export function viewportOf(term) {
  return term?.element?.closest(".terminal-pane")?.querySelector(".xterm-viewport") || null;
}

/** Find the viewport element for the active terminal pane (UI-only uses) */
export function activeViewport() {
  return document.querySelector(".terminal-pane.active .xterm-viewport")
    || document.querySelector(".xterm-viewport");
}

/**
 * Check if viewport is at bottom
 */
export function isAtBottom(viewport) {
  if (!viewport) return true;
  // Dynamic threshold: 10px minimum or 2% of viewport height (better for high-DPI)
  const threshold = Math.max(10, viewport.clientHeight * 0.02);
  return viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - threshold;
}

/**
 * Scroll to bottom
 */
export const scrollToBottom = (term) => {
  requestAnimationFrame(() => term.scrollToBottom());
};

/**
 * Preserve scroll position during operation (composable).
 * Derives viewport from the terminal instance, not from the active pane.
 */
export const withPreservedScroll = (term, operation) => {
  const viewport = viewportOf(term);
  const wasAtBottom = isAtBottom(viewport);
  const scrollTop = viewport?.scrollTop ?? 0;
  operation();
  if (wasAtBottom) {
    scrollToBottom(term);
  } else if (viewport) {
    // Restore scroll position after reflow (e.g. fit/resize) to prevent
    // the viewport from jumping when the user has scrolled up.
    viewport.scrollTop = scrollTop;
  }
};

/**
 * Terminal write with preserved scroll (composable).
 * Derives viewport from the terminal instance, not from the active pane.
 */
export const terminalWriteWithScroll = (term, data, onComplete) => {
  const viewport = viewportOf(term);
  const wasAtBottom = isAtBottom(viewport);
  term.write(data, () => {
    if (wasAtBottom) scrollToBottom(term);
    if (onComplete) onComplete();
  });
};
