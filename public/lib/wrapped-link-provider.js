/**
 * Wrapped Link Provider
 *
 * Custom xterm.js link provider that detects URLs spanning across terminal
 * line wraps — including hard-wrapped lines where isWrapped is false.
 *
 * Problem: xterm.js WebLinksAddon only joins lines marked with isWrapped.
 * When tmux redraws the screen (reconnect, resize, scroll-back replay), it
 * emits explicit cursor positioning instead of relying on terminal soft-wrap,
 * so isWrapped is false despite the URL being visually continuous. Clicking
 * the link captures only the fragment on the clicked line.
 *
 * Solution: in addition to checking isWrapped, treat a line that fills the
 * full terminal width as a potential wrap point — if the next line doesn't
 * start with whitespace, join them before running the URL regex.
 */

// Same regex as xterm.js WebLinksAddon default
const URL_RE =
  /(https?|HTTPS?):\/\/[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

/**
 * Register the wrapped link provider on a terminal instance.
 * Returns a disposable that removes the provider.
 *
 * @param {import('xterm').Terminal} terminal
 * @param {function} [handler] - Link click handler (event, url) => void
 * @returns {{ dispose(): void }}
 */
export function registerWrappedLinkProvider(terminal, handler) {
  const open = handler || defaultOpen;
  return terminal.registerLinkProvider(
    new WrappedLinkProvider(terminal, open),
  );
}

export class WrappedLinkProvider {
  constructor(terminal, handler) {
    this._terminal = terminal;
    this._handler = handler || defaultOpen;
  }

  provideLinks(lineNumber, callback) {
    const buf = this._terminal.buffer.active;
    const cols = this._terminal.cols;
    const y = lineNumber - 1; // 0-based

    // Build a window of contiguous lines that could contain a single
    // wrapped URL spanning the requested line.
    const startY = scanBackward(buf, y, cols);
    const endY = scanForward(buf, y, cols);

    // Collect trimmed line strings
    const texts = [];
    for (let i = startY; i <= endY; i++) {
      const line = buf.getLine(i);
      texts.push(line ? line.translateToString(true) : "");
    }

    const joined = texts.join("");
    const re = new RegExp(URL_RE.source, "gi");
    const links = [];
    let m;

    while ((m = re.exec(joined)) !== null) {
      const url = m[0];
      const start = offsetToCoord(texts, startY, m.index);
      const end = offsetToCoord(texts, startY, m.index + url.length - 1);
      if (!start || !end) continue;

      // Only return links that overlap the requested line
      if (start.y > y || end.y < y) continue;

      links.push({
        range: {
          start: { x: start.x + 1, y: start.y + 1 },
          end: { x: end.x + 1, y: end.y + 1 },
        },
        text: url,
        activate: (_ev, text) => this._handler(_ev, text),
      });
    }

    callback(links.length ? links : undefined);
  }
}

// -- Internal helpers (exported for testing) ----------------------------------

/**
 * Scan backward from line y to find the first line of a contiguous
 * wrapped paragraph. A line is considered a continuation if:
 * - xterm marked it as isWrapped (soft-wrap), OR
 * - the preceding line fills the full terminal width AND this line
 *   doesn't start with whitespace (hard-wrap from tmux redraw).
 */
export function scanBackward(buf, y, cols) {
  let startY = y;
  for (let i = y; i > 0 && i > y - 10; i--) {
    const line = buf.getLine(i);
    if (!line) break;
    if (line.isWrapped) {
      startY = i - 1;
      continue;
    }
    const prev = buf.getLine(i - 1);
    if (!prev) break;
    if (prev.translateToString(true).length >= cols) {
      const text = line.translateToString(true);
      if (text.length > 0 && !/^\s/.test(text)) {
        startY = i - 1;
        continue;
      }
    }
    break;
  }
  return startY;
}

/**
 * Scan forward from line y to find the last line of a contiguous
 * wrapped paragraph. Mirror logic of scanBackward.
 */
export function scanForward(buf, y, cols) {
  let endY = y;
  for (let i = y; i < buf.length - 1 && i < y + 10; i++) {
    const next = buf.getLine(i + 1);
    if (!next) break;
    if (next.isWrapped) {
      endY = i + 1;
      continue;
    }
    const curr = buf.getLine(i);
    if (!curr) break;
    if (curr.translateToString(true).length >= cols) {
      const nextText = next.translateToString(true);
      if (nextText.length > 0 && !/^\s/.test(nextText)) {
        endY = i + 1;
        continue;
      }
    }
    break;
  }
  return endY;
}

/**
 * Map a character offset within joined line texts to terminal coordinates.
 * @returns {{ x: number, y: number }} 0-based, or null if out of range.
 */
export function offsetToCoord(texts, startY, offset) {
  let rem = offset;
  for (let i = 0; i < texts.length; i++) {
    if (rem < texts[i].length) return { x: rem, y: startY + i };
    rem -= texts[i].length;
  }
  // Offset is at/past the end — clamp to last character
  const last = texts.length - 1;
  if (texts[last].length === 0) return null;
  return { x: texts[last].length - 1, y: startY + last };
}

function defaultOpen(_event, url) {
  const w = window.open();
  if (w) {
    try {
      w.opener = null;
    } catch {
      /* ignore */
    }
    w.location.href = url;
  }
}
