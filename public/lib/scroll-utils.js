/**
 * Scroll State Utilities
 *
 * Composable scroll management helpers for terminal.
 *
 * Tracks scroll state so rapid terminal output (e.g. Claude Code typing)
 * doesn't yank the viewport back to the bottom while the user is reading
 * scrollback.  The lock follows the buffer's viewport position: set when
 * away from bottom, cleared on arrival.
 *
 * Scroll architecture: native browser scroll is disabled on the terminal
 * pane (#terminal-container .xterm-viewport { overflow: clip }) so all
 * viewport movement flows through `term.scrollLines()`. `clip` is load-
 * bearing on iPadOS WebKit — `hidden` still creates a scroll container
 * whose compositor layer wheel events translate independently of xterm's
 * redraw, ghosting rows on trackpad scroll.
 *   - wheel/trackpad → xterm's built-in wheel handler
 *   - touch drag    → initTouchScroll's pointer bridge
 *   - programmatic  → scrollToBottom, etc.
 * Every path triggers `term.onScroll`, which is the single source of
 * truth for tracking scroll-lock state.
 *
 * IMPORTANT: xterm.js 6 uses a custom scrollable element — native DOM
 * scroll properties (scrollTop, scrollHeight) are NOT meaningful. All
 * scroll position checks use the terminal buffer API:
 *   buffer.active.baseY  — total lines above the visible area
 *   buffer.active.viewportY — current scroll offset from top
 *   viewportY === baseY means "at bottom"
 */

// --- Per-terminal scroll-lock state (WeakMap so GC-friendly) ---
const _scrollLocked = new WeakMap();

/**
 * Check if terminal is scrolled to the bottom.
 * Uses xterm.js buffer API, not DOM scroll properties.
 */
export function isAtBottom(term) {
  if (!term?.buffer?.active) return true;
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY;
}

/**
 * Attach scroll-lock tracking to a terminal.
 * Call once per terminal (idempotent — skips if already attached).
 *
 * Lock follows the buffer position via term.onScroll, which fires for
 * every viewport movement (wheel, touch, scrollbar, programmatic).
 */
export function initScrollTracking(term) {
  if (_scrollLocked.has(term)) return;
  _scrollLocked.set(term, false);

  term.onScroll(() => {
    _scrollLocked.set(term, !isAtBottom(term));
  });
}

/**
 * Scroll to bottom with smooth easing (also clears scroll lock).
 *
 * Animates the scroll using an easeOutBack curve.
 * xterm.js doesn't support native smooth scrolling, so we step
 * through scrollLines() on each animation frame.
 *
 * Two streaming-output fixes baked in:
 *  1. Live re-targeting — each frame re-reads buffer.active and eases
 *     toward the *current* baseY, so new lines arriving mid-animation
 *     (tail -f, build logs, Claude Code typing) extend the journey
 *     instead of stranding the user at the old bottom.
 *  2. Deferred final snap — the final "ensure at bottom" call rides
 *     xterm's WriteBuffer queue via `term.write("", cb)`, so it fires
 *     *after* any in-flight (queued) writes have flushed. Without this,
 *     a synchronous term.scrollToBottom() can land before pending writes
 *     grow baseY again, leaving the viewport stuck partway.
 */
let _smoothScrollRaf = 0;
export const scrollToBottom = (term, { smooth = true } = {}) => {
  // term.write() is async (queued in xterm's WriteBuffer). A synchronous
  // term.scrollToBottom() can race in-flight writes. Riding the queue
  // with term.write("", cb) guarantees we snap after pending output.
  _scrollLocked.set(term, false);

  if (!smooth) {
    if (_smoothScrollRaf) { cancelAnimationFrame(_smoothScrollRaf); _smoothScrollRaf = 0; }
    term.write("", () => term.scrollToBottom());
    return;
  }

  const buf = term.buffer.active;
  const remaining = buf.baseY - buf.viewportY;
  if (remaining <= 0) { term.write("", () => term.scrollToBottom()); return; }

  // For small distances, just jump
  if (remaining <= 3) { term.write("", () => term.scrollToBottom()); return; }

  const duration = Math.min(500, 150 + remaining * 0.8); // 150-500ms depending on distance
  const startTime = performance.now();
  const startOffset = buf.viewportY;

  // Flat acceleration into bouncy overshoot deceleration.
  // Inspired by iOS rubber-band: linear ramp up, then elastic settle.
  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function step(now) {
    // Re-read the buffer every frame so streaming output extends the
    // target instead of leaving us aimed at the stale "bottom at click".
    const liveBuf = term.buffer.active;
    const currentBaseY = liveBuf.baseY;
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const easedProgress = easeOutBack(progress);
    const targetY = Math.round(startOffset + (currentBaseY - startOffset) * easedProgress);
    const currentY = liveBuf.viewportY;
    const linesToScroll = targetY - currentY;

    if (linesToScroll > 0) term.scrollLines(linesToScroll);

    if (progress < 1) {
      _smoothScrollRaf = requestAnimationFrame(step);
    } else {
      _smoothScrollRaf = 0;
      // Defer the final snap past any in-flight xterm writes.
      term.write("", () => term.scrollToBottom());
    }
  }

  if (_smoothScrollRaf) cancelAnimationFrame(_smoothScrollRaf);
  _smoothScrollRaf = requestAnimationFrame(step);
};

/**
 * Enable touch-based scrolling for a terminal.
 *
 * xterm.js 6's scrollable element only handles wheel events — touch
 * scrolling is not supported. This bridge converts vertical touch-drag
 * gestures into term.scrollLines() calls.
 *
 * Uses pointer events (not touch events) because:
 * - Pointer events are the modern unified API for mouse/touch/pen
 * - They fire reliably on Android Chrome without compositor interference
 *   (Android's compositor can consume touch events for native scroll
 *   before JavaScript sees them, even with touch-action:none)
 * - They work identically across iOS Safari, Android Chrome, and desktop
 *
 * Each terminal gets its own pointer handler on its element, using
 * setPointerCapture to ensure all pointermove events route to the
 * terminal even if the finger moves outside it.
 *
 * Call once per terminal (idempotent via WeakSet).
 */
const _touchScrollAttached = new WeakSet();

export function initTouchScroll(term) {
  if (_touchScrollAttached.has(term)) return;
  _touchScrollAttached.add(term);

  const el = term.element;
  if (!el) return;

  let activePointerId = -1;
  let startY = 0;
  let lastY = 0;
  let scrolling = false;
  let accDelta = 0;

  function cellHeight() {
    try {
      return term._core._renderService.dimensions.css.cell.height;
    } catch {
      const rect = el.getBoundingClientRect();
      return rect.height / term.rows;
    }
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || activePointerId !== -1) return;
    activePointerId = e.pointerId;
    startY = e.clientY;
    lastY = startY;
    scrolling = false;
    accDelta = 0;
    // Capture so pointermove keeps firing even if finger leaves element
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointerId) return;
    const y = e.clientY;
    const dy = lastY - y; // positive = finger up = scroll down
    lastY = y;

    if (!scrolling) {
      if (Math.abs(y - startY) < 10) return;
      scrolling = true;
    }

    accDelta += dy;
    const rowH = cellHeight();
    const lines = Math.trunc(accDelta / rowH);
    if (lines !== 0) {
      term.scrollLines(lines);
      accDelta -= lines * rowH;
    }
  });

  el.addEventListener("pointerup", (e) => {
    if (e.pointerId === activePointerId) activePointerId = -1;
  });

  el.addEventListener("pointercancel", (e) => {
    if (e.pointerId === activePointerId) activePointerId = -1;
  });
}

/**
 * Preserve scroll position during operation (composable).
 * Derives scroll state from the terminal buffer, not DOM.
 */
export const withPreservedScroll = (term, operation) => {
  const locked = _scrollLocked.get(term) || false;
  const wasAtBottom = !locked && isAtBottom(term);
  const viewportY = term?.buffer?.active?.viewportY ?? 0;
  operation();
  if (wasAtBottom) {
    scrollToBottom(term, { smooth: false });
  } else if (term?.buffer?.active) {
    // Restore scroll position after reflow (e.g. fit/resize) to prevent
    // the viewport from jumping when the user has scrolled up.
    const delta = viewportY - term.buffer.active.viewportY;
    if (delta !== 0) term.scrollLines(-delta);
  }
};

/**
 * Terminal write with preserved scroll (composable).
 * Uses terminal buffer API for scroll state.
 * Respects scroll lock — if the user scrolled up, new output won't
 * yank the viewport back to the bottom.
 */
export const terminalWriteWithScroll = (term, data, onComplete) => {
  const locked = _scrollLocked.get(term) || false;
  const wasAtBottom = !locked && isAtBottom(term);
  term.write(data, () => {
    if (wasAtBottom) scrollToBottom(term, { smooth: false });
    if (onComplete) onComplete();
  });
};
