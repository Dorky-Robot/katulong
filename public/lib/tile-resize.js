/**
 * Tile Resize Handles
 *
 * Per-card edge resize handles for the carousel. Each card gets left and right
 * handles positioned absolute on its edges. Dragging a handle resizes the card
 * symmetrically (both sides grow/shrink equally, keeping the card centered).
 *
 * Key design decisions informed by past experience (diwa):
 * - Per-card handles instead of between-card separators (works for single card)
 * - `.resizing` class during drag disables CSS transitions (prevents input lag)
 * - Widths are applied via the `--w` CSS variable on the card. The CSS rule
 *   for `.carousel-card` derives both `width` and `margin-left: calc(var(--w)
 *   / -2)` from this single variable, so the centering formula lives in CSS
 *   as a single source of truth. Setting `--w` instead of an inline `width`
 *   pixel value also avoids CSS flex reflow during drag — the rule still
 *   resolves to a definite pixel width.
 * - e.preventDefault() on touchstart prevents browser scroll fighting drag
 * - Symmetrical resize: dragging one edge changes width by 2x the delta
 *   because the card is centered (both sides move equally)
 *
 * @see commit b0088ba — CSS transitions must be disabled during drag
 * @see commit 4c33b53 — Per-card edge handles replace between-card separators
 * @see commit d23f021 — Explicit pixel widths, not CSS flex reflow
 */

const DEFAULT_MIN_WIDTH = 200;
const HANDLE_WIDTH = 12; // px, touch-friendly

/**
 * Create resize handles for a carousel card.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.card — the .carousel-card element
 * @param {function} opts.onResize — called with (newWidth) during resize
 * @param {function} [opts.onResizeEnd] — called with (finalWidth) when drag ends
 * @param {number} [opts.minWidth=200] — minimum card width in px
 * @param {number} [opts.maxWidth] — maximum card width in px (defaults to window width)
 * @returns {ResizeHandles}
 */
export function createResizeHandles({ card, onResize, onResizeEnd, minWidth, maxWidth }) {
  const min = minWidth ?? DEFAULT_MIN_WIDTH;
  let currentWidth = null; // null = CSS-controlled (no custom width)
  let leftHandle = null;
  let rightHandle = null;
  let attached = false;

  // Drag state
  let dragging = false;
  let dragSide = null;  // "left" | "right"
  let dragStartX = 0;
  let dragStartWidth = 0;

  // ── Clamping ──────────────────────────────────────────────────────

  function clamp(width) {
    const max = maxWidth ?? (globalThis.window?.innerWidth ?? 1024);
    return Math.max(min, Math.min(max, Math.round(width)));
  }

  // ── Handle DOM ────────────────────────────────────────────────────

  function createHandle(side) {
    const el = document.createElement("div");
    el.className = `resize-handle resize-handle-${side}`;

    // ── Pointer events (unified mouse + touch) ──────────────────
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDrag(side, e.clientX);

      // Use pointer capture for reliable move/up tracking
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    });

    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      e.preventDefault();
      moveDrag(e.clientX);
    });

    el.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      endDrag();
      if (el.releasePointerCapture) el.releasePointerCapture(e.pointerId);
    });

    el.addEventListener("pointercancel", (e) => {
      if (!dragging) return;
      endDrag();
    });

    // Prevent touch scroll while dragging handle
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
    }, { passive: false });

    return el;
  }

  // ── Drag logic ────────────────────────────────────────────────────

  function startDrag(side, x) {
    dragging = true;
    dragSide = side;
    dragStartX = x;
    // Read current card width at drag start
    const rect = card.getBoundingClientRect();
    dragStartWidth = currentWidth ?? rect.width;

    // Disable CSS transitions during drag (diwa: b0088ba)
    card.classList.add("resizing");
  }

  function moveDrag(x) {
    if (!dragging) return;
    const delta = dragSide === "right"
      ? x - dragStartX
      : dragStartX - x;

    // Symmetrical: delta * 2 because card is centered
    const newWidth = clamp(dragStartWidth + delta * 2);
    currentWidth = newWidth;
    applyWidth(newWidth);
    if (onResize) onResize(newWidth);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    card.classList.remove("resizing");
    if (onResizeEnd && currentWidth !== null) {
      onResizeEnd(currentWidth);
    }
    dragSide = null;
  }

  // ── Width application ─────────────────────────────────────────────

  function applyWidth(width) {
    if (width === null) {
      card.style.removeProperty('--w');
    } else {
      card.style.setProperty('--w', `${width}px`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────

  function attach() {
    if (attached) return;
    leftHandle = createHandle("left");
    rightHandle = createHandle("right");
    card.appendChild(leftHandle);
    card.appendChild(rightHandle);
    attached = true;
  }

  function detach() {
    if (!attached) return;
    if (leftHandle) { leftHandle.remove(); leftHandle = null; }
    if (rightHandle) { rightHandle.remove(); rightHandle = null; }
    attached = false;
  }

  function getWidth() {
    return currentWidth;
  }

  function setWidth(width) {
    if (width === null) {
      currentWidth = null;
      applyWidth(null);
      return;
    }
    const clamped = clamp(width);
    currentWidth = clamped;
    applyWidth(clamped);
    if (onResize) onResize(clamped);
  }

  function resetWidth() {
    currentWidth = null;
    applyWidth(null);
  }

  function serialize() {
    return currentWidth;
  }

  function restore(width) {
    if (width === null || width === undefined) return;
    setWidth(width);
  }

  return {
    attach,
    detach,
    getWidth,
    setWidth,
    resetWidth,
    serialize,
    restore,

    // ── Test helpers (prefixed with _test) ────────────────────────
    // These expose internal state for unit testing without needing
    // to simulate full pointer events in a headless environment.
    _testClamp: clamp,
    _testDragStart: (side = "right", x = 0) => startDrag(side, x),
    _testDragMove: (x) => moveDrag(x),
    _testDragEnd: () => endDrag(),
  };
}
