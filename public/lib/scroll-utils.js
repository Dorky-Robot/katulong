/**
 * Scroll State Utilities
 *
 * Composable scroll management helpers for terminal.
 *
 * Tracks user-initiated scrolling so that rapid terminal output (e.g.
 * Claude Code working) doesn't yank the viewport back to the bottom
 * every frame.  The lock is set on wheel / touchmove events when the
 * viewport is away from the bottom, and cleared when the viewport
 * reaches the bottom again (via any means — manual scroll, button
 * click, or programmatic scrollToBottom).
 */

// --- Per-viewport scroll-lock state (WeakMap so GC-friendly) ---
const _scrollLocked = new WeakMap();

/** Derive the scrollable viewport element from a terminal instance's own DOM */
export function viewportOf(term) {
  const pane = term?.element?.closest(".terminal-pane");
  if (!pane) return null;
  // xterm 6 uses .xterm-scrollable-element; fall back to .xterm-viewport for older versions
  return pane.querySelector(".xterm-scrollable-element") || pane.querySelector(".xterm-viewport") || null;
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
 * Attach scroll-lock tracking to a terminal's viewport.
 * Call once per terminal (idempotent — skips if already attached).
 *
 * Wheel / touchmove away from bottom → lock (suppress auto-scroll).
 * Scroll back to bottom (any means)  → unlock.
 */
export function initScrollTracking(term) {
  const viewport = viewportOf(term);
  if (!viewport || _scrollLocked.has(viewport)) return;
  _scrollLocked.set(viewport, false);

  const markUserScroll = () => {
    if (!isAtBottom(viewport)) _scrollLocked.set(viewport, true);
  };

  viewport.addEventListener("wheel", markUserScroll, { passive: true });
  viewport.addEventListener("touchmove", markUserScroll, { passive: true });

  // Clear lock when viewport reaches bottom via any means
  viewport.addEventListener("scroll", () => {
    if (isAtBottom(viewport)) _scrollLocked.set(viewport, false);
  }, { passive: true });
}

/**
 * Scroll to bottom (also clears scroll lock)
 */
export const scrollToBottom = (term) => {
  const viewport = viewportOf(term);
  if (viewport) _scrollLocked.set(viewport, false);
  requestAnimationFrame(() => term.scrollToBottom());
};

/**
 * Preserve scroll position during operation (composable).
 * Derives viewport from the terminal instance, not from the active pane.
 */
export const withPreservedScroll = (term, operation) => {
  const viewport = viewportOf(term);
  const locked = viewport ? _scrollLocked.get(viewport) : false;
  const wasAtBottom = !locked && isAtBottom(viewport);
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
 * Respects scroll lock — if the user scrolled up, new output won't
 * yank the viewport back to the bottom.
 */
export const terminalWriteWithScroll = (term, data, onComplete) => {
  const viewport = viewportOf(term);
  const locked = viewport ? _scrollLocked.get(viewport) : false;
  const wasAtBottom = !locked && isAtBottom(viewport);
  term.write(data, () => {
    if (wasAtBottom) scrollToBottom(term);
    if (onComplete) onComplete();
  });
};
