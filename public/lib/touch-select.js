/**
 * Touch Selection Handler
 *
 * Enables text selection via finger touch on xterm.js terminals.
 *
 * xterm.js only handles mouse/trackpad selection natively. On touch devices
 * (iPad with finger), touches don't create selections. This module converts
 * touch gestures into programmatic xterm selections:
 *
 * - Long-press (400ms) enters selection mode and selects the touched word
 * - Drag after long-press extends the selection
 * - Tap without hold does nothing (preserves normal touch behavior)
 * - Selection auto-copies to clipboard via the existing onSelectionChange handler
 */

const LONG_PRESS_MS = 400;
const MOVE_THRESHOLD = 10; // px — movement beyond this cancels long-press

/**
 * Convert touch coordinates to terminal row/col.
 *
 * Uses xterm's internal render dimensions for accurate cell sizing.
 * Falls back to a heuristic based on terminal element size and cols/rows.
 */
function touchToCell(term, touchX, touchY) {
  const rect = term.element.getBoundingClientRect();
  const x = touchX - rect.left;
  const y = touchY - rect.top;

  let cellW, cellH;
  try {
    const dims = term._core._renderService.dimensions.css.cell;
    cellW = dims.width;
    cellH = dims.height;
  } catch {
    // Fallback: estimate from element size
    cellW = rect.width / term.cols;
    cellH = rect.height / term.rows;
  }

  const col = Math.max(0, Math.min(term.cols - 1, Math.floor(x / cellW)));
  const row = Math.max(0, Math.min(term.rows - 1, Math.floor(y / cellH)));
  return { col, row };
}

/**
 * Get the word boundaries at a given position in the terminal buffer.
 * Returns { start, end } column indices (end is exclusive).
 */
function wordBoundsAt(term, col, row) {
  const bufferRow = row + term.buffer.active.viewportY;
  const line = term.buffer.active.getLine(bufferRow);
  if (!line) return { start: col, end: col + 1 };

  const text = line.translateToString(false);
  if (!text || col >= text.length) return { start: col, end: col + 1 };

  // Word characters: anything that isn't whitespace or common delimiters
  const isWordChar = (ch) => /[^\s\t|&;()<>{}[\]"'`$\\]/.test(ch);

  if (!isWordChar(text[col])) {
    // Tapped on whitespace/delimiter — select just that character
    return { start: col, end: col + 1 };
  }

  let start = col;
  while (start > 0 && isWordChar(text[start - 1])) start--;

  let end = col + 1;
  while (end < text.length && isWordChar(text[end])) end++;

  return { start, end };
}

/**
 * Attach touch selection to a terminal instance.
 * Returns a cleanup function.
 */
export function attachTouchSelect(term) {
  let pressTimer = null;
  let selecting = false;
  let anchorRow = 0;
  let anchorCol = 0;
  let startX = 0;
  let startY = 0;

  const el = term.element;
  if (!el) return () => {};

  function onTouchStart(e) {
    // Only handle single-finger touches on the terminal canvas area
    if (e.touches.length !== 1) return;
    const target = e.target;
    // Don't interfere with joystick, key-island, or other UI
    if (target.closest("#key-island") || target.closest("#joystick")) return;

    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    selecting = false;

    pressTimer = setTimeout(() => {
      pressTimer = null;
      selecting = true;

      const { col, row } = touchToCell(term, t.clientX, t.clientY);
      const bounds = wordBoundsAt(term, col, row);
      anchorRow = row;
      anchorCol = bounds.start;

      // Select the word under the finger
      term.select(bounds.start, row + term.buffer.active.viewportY, bounds.end - bounds.start);

      // Prevent context menu / magnifier from iOS
      e.preventDefault();
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    if (!selecting) {
      // Cancel long-press if finger moved too much
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD && pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      return;
    }

    // Extend selection from anchor to current touch position
    e.preventDefault();
    const { col, row } = touchToCell(term, t.clientX, t.clientY);
    const viewportY = term.buffer.active.viewportY;

    // Determine selection direction
    const anchorAbsolute = anchorRow + viewportY;
    const currentAbsolute = row + viewportY;

    let startCol, startRow, length;
    if (currentAbsolute < anchorAbsolute || (currentAbsolute === anchorAbsolute && col < anchorCol)) {
      // Selecting backwards
      startCol = col;
      startRow = currentAbsolute;
      length = (anchorAbsolute - currentAbsolute) * term.cols + (anchorCol - col);
    } else {
      // Selecting forwards
      startCol = anchorCol;
      startRow = anchorAbsolute;
      length = (currentAbsolute - anchorAbsolute) * term.cols + (col - anchorCol) + 1;
    }

    term.select(startCol, startRow, length);
  }

  function onTouchEnd(e) {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (selecting) {
      // Keep selection visible — it will be copied by the onSelectionChange handler
      selecting = false;
      e.preventDefault();
    }
  }

  function onTouchCancel() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    selecting = false;
  }

  el.addEventListener("touchstart", onTouchStart, { passive: false });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: false });
  el.addEventListener("touchcancel", onTouchCancel);

  return () => {
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchCancel);
    if (pressTimer) clearTimeout(pressTimer);
  };
}
