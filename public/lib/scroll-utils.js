/**
 * Scroll State Utilities
 *
 * Composable scroll management helpers for terminal.
 */

/**
 * Check if viewport is at bottom
 */
export function isAtBottom(viewport = document.querySelector(".xterm-viewport")) {
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
  const viewport = document.querySelector(".xterm-viewport");
  const wasAtBottom = isAtBottom(viewport);
  operation();
  if (wasAtBottom) scrollToBottom(term);
};

/**
 * Terminal write with preserved scroll (composable)
 */
export const terminalWriteWithScroll = (term, data, onComplete) => {
  const viewport = document.querySelector(".xterm-viewport");
  const wasAtBottom = isAtBottom(viewport);
  term.write(data, () => {
    if (wasAtBottom) scrollToBottom(term);
    if (onComplete) onComplete();
  });
};
