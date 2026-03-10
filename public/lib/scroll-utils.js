/**
 * Scroll State Utilities
 *
 * Composable scroll management helpers for terminal.
 */

/** Find the viewport element for the active terminal pane */
export function activeViewport() {
  return document.querySelector(".terminal-pane.active .xterm-viewport")
    || document.querySelector(".xterm-viewport");
}

/**
 * Check if viewport is at bottom
 */
export function isAtBottom(viewport = activeViewport()) {
  if (!viewport) return true;
  // Dynamic threshold: 10px minimum or 2% of viewport height (better for high-DPI)
  const threshold = Math.max(10, viewport.clientHeight * 0.02);
  return viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - threshold;
}

/**
 * Scroll to bottom with double RAF for layout settling
 */
export const scrollToBottom = (term) => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => term.scrollToBottom());
  });
};

/**
 * Preserve scroll position during operation (composable)
 */
export const withPreservedScroll = (term, operation) => {
  const viewport = activeViewport();
  const wasAtBottom = isAtBottom(viewport);
  operation();
  if (wasAtBottom) scrollToBottom(term);
};

/**
 * Terminal write with preserved scroll (composable)
 */
export const terminalWriteWithScroll = (term, data, onComplete) => {
  const viewport = activeViewport();
  const wasAtBottom = isAtBottom(viewport);
  term.write(data, () => {
    if (wasAtBottom) scrollToBottom(term);
    if (onComplete) onComplete();
  });
};
