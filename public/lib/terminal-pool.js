/**
 * Terminal Pool Manager
 *
 * Manages a bounded pool of xterm.js Terminal instances, one per session.
 * Switching sessions toggles container visibility instead of clearing/resetting.
 * LRU eviction keeps memory bounded.
 */

import { Terminal } from "/vendor/xterm/xterm.esm.js";
import { registerWrappedLinkProvider } from "/lib/wrapped-link-provider.js";
import { SearchAddon } from "/vendor/xterm/addon-search.esm.js";
import { ClipboardAddon } from "/vendor/xterm/addon-clipboard.esm.js";
import { WebglAddon } from "/vendor/xterm/addon-webgl.esm.js";
import { DEFAULT_COLS } from "/lib/terminal-config.js";

const MAX_POOL_SIZE = 5;

// Experiment: render the WebGL drawing buffer in Display P3 when the
// display supports it. sRGB theme hex values get displayed against P3
// primaries, so saturated colors "pop" the way they do in native GPU
// terminals (Warp, iTerm2 on Metal). Monkey-patches getContext once at
// module load so we don't have to reach into WebglAddon internals.
(function enableWideGamutWebGL() {
  if (typeof window === "undefined") return;
  if (!window.matchMedia?.("(color-gamut: p3)").matches) return;
  if (!("WebGL2RenderingContext" in window)) return;
  if (!("drawingBufferColorSpace" in WebGL2RenderingContext.prototype)) return;

  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = orig.call(this, type, attrs);
    if (type === "webgl2" && ctx) {
      try { ctx.drawingBufferColorSpace = "display-p3"; } catch {}
    }
    return ctx;
  };
})();

/** Load WebGL renderer with automatic fallback to DOM on failure. */
function loadWebGL(term) {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
    });
    term.loadAddon(addon);
  } catch {
    // WebGL2 not available — DOM renderer stays active
  }
}

/** Measure char width ratio for the terminal's font family. */
function getCharRatio(term) {
  const dims = term._core?._renderService?.dimensions;
  if (dims?.css?.cell?.width) {
    return dims.css.cell.width / (term.options.fontSize || 14);
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const family = term.options.fontFamily || "monospace";
  ctx.font = `14px ${family.split(",")[0].trim().replace(/'/g, "")}`;
  return ctx.measureText("W").width / 14;
}

/** Calculate font size that fits the given number of cols in the given width. */
function fontSizeForWidth(term, width, cols) {
  const charRatio = getCharRatio(term);
  const exactSize = width / (cols * charRatio);
  // Round DOWN to 0.5px steps so the terminal never overflows the container.
  return Math.max(6, Math.floor(exactSize * 2) / 2);
}

/**
 * Full init: set font size, cols, and rows for a terminal in its container.
 * Called once on activation/session switch — NOT on browser resize.
 *
 * Cols are calculated from the available content width divided by character
 * width, so each client gets a column count that fits its viewport.
 * DEFAULT_COLS is only used as a fallback when dimensions can't be measured.
 *
 * Returns { cols, rows, changed } where `changed` is true if the terminal
 * was actually resized, or null if the container is not visible.
 */
function scaleToFit(term, container) {
  const rect = container.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  const style = getComputedStyle(container);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const contentWidth = rect.width - padLeft - padRight;
  // Only recalculate when width meaningfully changes (>1px).
  // Height-only changes (keyboard accessory bar) should not affect cols/font.
  const prevWidth = container._lastScaleWidth || 0;
  let fontSize = term.options.fontSize || 14;
  let cols = term.cols || DEFAULT_COLS;
  if (Math.abs(contentWidth - prevWidth) > 1) {
    container._lastScaleWidth = contentWidth;
    // Reserve a symmetric left/right gap (CSS margin:auto centers
    // the .xterm-screen, so the remainder splits evenly on both sides).
    // On narrow viewports (<600px, i.e. phones) use a minimal 2px gap
    // to maximize horizontal space; wider screens keep the 8px gap.
    const centeringGap = window.innerWidth < 600 ? 2 : 8;
    const availableWidth = contentWidth - centeringGap;

    // Calculate how many columns fit at the current font size.
    const charRatio = getCharRatio(term);
    const charWidth = fontSize * charRatio;
    cols = Math.max(2, Math.floor(availableWidth / charWidth));

    // Recalculate font size to exactly fit the calculated cols
    // (rounding may leave a small gap; this tightens it).
    fontSize = fontSizeForWidth(term, availableWidth, cols);
    term.options.fontSize = fontSize;
  }

  // Calculate rows from height, accounting for container padding
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  const availableHeight = rect.height - padTop - padBottom;

  const dims = term._core?._renderService?.dimensions;
  const cellHeight = dims?.css?.cell?.height
    ? dims.css.cell.height / (fontSize || 14) * fontSize
    : fontSize * 1.2;
  const rows = Math.max(2, Math.floor(availableHeight / cellHeight));

  let changed = false;
  if (term.cols !== cols || term.rows !== rows) {
    term.resize(cols, rows);
    changed = true;
  }

  return { cols, rows, changed };
}

/**
 * Create a terminal pool.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.parentEl - Container element for terminal panes
 * @param {object} opts.terminalOptions - xterm.js Terminal options
 * @param {function} opts.onTerminalCreated - Called after a new terminal is created: (sessionName, entry) => void
 * @returns {object} Pool API
 */
export function createTerminalPool({ parentEl, terminalOptions, onTerminalCreated, onResize }) {
  // sessionName -> { term, fit, searchAddon, container, lastUsed }
  const pool = new Map();
  let activeSession = null;
  // Sessions protected from LRU eviction (e.g. split secondary pane)
  const protectedSessions = new Set();

  // Debounce resize notifications to coalesce rapid events (activate rAF +
  // ResizeObserver firing within the same frame) into a single SIGWINCH.
  // Multiple SIGWINCHs in quick succession interrupt TUI apps mid-render,
  // causing garbled partial frames (scattered right-aligned text).
  const _resizeTimers = new Map();
  function debouncedResize(sessionName, cols, rows) {
    clearTimeout(_resizeTimers.get(sessionName));
    _resizeTimers.set(sessionName, setTimeout(() => {
      _resizeTimers.delete(sessionName);
      if (onResize) onResize(sessionName, cols, rows);
    }, 80));
  }

  function createEntry(sessionName) {
    // Evict LRU if at capacity
    if (pool.size >= MAX_POOL_SIZE) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [name, entry] of pool) {
        if (name === activeSession || protectedSessions.has(name)) continue; // never evict active/protected
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldest = name;
        }
      }
      if (oldest) dispose(oldest);
    }

    const term = new Terminal(terminalOptions);
    const searchAddon = new SearchAddon();

    registerWrappedLinkProvider(term);
    term.loadAddon(searchAddon);
    term.loadAddon(new ClipboardAddon());

    const container = document.createElement("div");
    container.className = "terminal-pane";
    container.dataset.session = sessionName;
    parentEl.appendChild(container);

    term.open(container);

    // GPU-accelerated rendering via WebGL. Falls back to default DOM
    // renderer on context loss or if WebGL2 is unavailable.
    loadWebGL(term);

    // Decouple xterm's input textarea from the rendering tree.
    // xterm repositions the textarea at the cursor on every cursor move
    // (_syncTextArea), including during DEC synchronized output frames.
    // WebKit renders the system caret independently of opacity/clip-path,
    // so the only reliable fix is to move it off-screen at the DOM level.
    // The textarea keeps focus and receives key events from any position.
    const textarea = container.querySelector(".xterm-helper-textarea");
    if (textarea) {
      const clip = document.createElement("div");
      clip.className = "xterm-input-clip";
      textarea.parentNode.insertBefore(clip, textarea);
      clip.appendChild(textarea);
    }

    const entry = { term, searchAddon, container, sessionName, lastUsed: Date.now() };
    pool.set(sessionName, entry);

    if (onTerminalCreated) onTerminalCreated(sessionName, entry);

    return entry;
  }

  function getOrCreate(sessionName) {
    let entry = pool.get(sessionName);
    if (!entry) {
      entry = createEntry(sessionName);
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  // Per-terminal UI: joystick and scroll button live inside the focused pane
  // so each terminal card acts as a self-contained screen (like a phone).
  const joystickEl = document.getElementById("joystick");
  const progressRing = document.getElementById("enter-progress-ring");
  const scrollBtn = document.getElementById("scroll-bottom");

  /** Move per-terminal UI (joystick, scroll button) into a session's pane. */
  function attachControls(sessionName) {
    const entry = pool.get(sessionName);
    if (!entry) return;
    if (joystickEl) entry.container.appendChild(joystickEl);
    if (progressRing) entry.container.appendChild(progressRing);
    if (scrollBtn) entry.container.appendChild(scrollBtn);
  }

  function activate(sessionName) {
    const entry = getOrCreate(sessionName);

    // Hide all panes, show the active one
    for (const [name, e] of pool) {
      e.container.classList.toggle("active", name === sessionName);
    }

    activeSession = sessionName;
    entry.lastUsed = Date.now();

    attachControls(sessionName);

    // Fit after visibility change (needs to be visible for correct dimensions).
    // Guard against the entry being disposed before the rAF fires.
    requestAnimationFrame(() => {
      if (!pool.has(sessionName)) return;
      const result = scaleToFit(entry.term, entry.container);
      entry.term.focus();
      // Only notify server if dimensions actually changed — otherwise
      // the resize triggers tmux redraws that duplicate content.
      if (result?.changed) {
        debouncedResize(sessionName, entry.term.cols, entry.term.rows);
      }
    });

    return entry;
  }

  function dispose(sessionName) {
    const entry = pool.get(sessionName);
    if (!entry) return;
    entry.term.dispose();
    entry.container.remove();
    pool.delete(sessionName);
    if (activeSession === sessionName) activeSession = null;
  }

  function getActive() {
    if (!activeSession) return null;
    return pool.get(activeSession) || null;
  }

  function getActiveName() {
    return activeSession;
  }

  function get(sessionName) {
    return pool.get(sessionName) || null;
  }

  function has(sessionName) {
    return pool.has(sessionName);
  }

  function rename(oldName, newName) {
    const entry = pool.get(oldName);
    if (!entry) return;
    pool.delete(oldName);
    entry.sessionName = newName;
    entry.container.dataset.session = newName;
    pool.set(newName, entry);
    if (activeSession === oldName) activeSession = newName;
  }

  /** Apply a function to every terminal in the pool */
  function forEach(fn) {
    for (const [name, entry] of pool) {
      fn(name, entry);
    }
  }

  /** Mark a session as protected from LRU eviction (e.g. split secondary) */
  function protect(sessionName) { protectedSessions.add(sessionName); }
  function unprotect(sessionName) { protectedSessions.delete(sessionName); }

  /** Full init: set font size + cols + rows for a terminal.
   *  Notifies the server if dimensions changed.
   *  Returns true if the terminal was resized, false otherwise. */
  function scale(sessionName) {
    const entry = pool.get(sessionName);
    if (!entry) return false;
    const result = scaleToFit(entry.term, entry.container);
    if (result?.changed) {
      debouncedResize(sessionName, entry.term.cols, entry.term.rows);
    }
    return result?.changed ?? false;
  }

  /** Full init for all terminals. Notifies server for each that changed. */
  function scaleAll() {
    for (const [name, entry] of pool) {
      const result = scaleToFit(entry.term, entry.container);
      if (result?.changed) {
        debouncedResize(name, entry.term.cols, entry.term.rows);
      }
    }
  }

  // Auto-rescale active terminal when container size changes (browser resize,
  // orientation change, split view, etc.).
  // Use rounded comparison (1px threshold) to ignore subpixel layout shifts
  // that occur on tap/focus on mobile browsers (e.g., iOS focus ring adjustments,
  // safe-area recalculations). Without this, every tap on the terminal fires a
  // resize that causes unnecessary tmux redraws.
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (Math.abs(width - lastW) < 1 && Math.abs(height - lastH) < 1) return;
    lastW = width; lastH = height;
    if (!activeSession) return;
    const active = pool.get(activeSession);
    if (active) {
      const result = scaleToFit(active.term, active.container);
      // Only force repaint when dimensions actually changed — otherwise
      // we cause unnecessary redraws on every subpixel layout shift
      // (e.g., tapping the terminal on iPad to focus it).
      if (result?.changed) {
        active.term.refresh(0, active.term.rows - 1);
        debouncedResize(activeSession, active.term.cols, active.term.rows);
      }
    }
  });
  ro.observe(parentEl);

  return {
    get,
    getOrCreate,
    activate,
    attachControls,
    dispose,
    getActive,
    getActiveName,
    has,
    rename,
    forEach,
    protect,
    unprotect,
    scale,
    scaleAll,
    setActive(name) { activeSession = name; },
    DEFAULT_COLS,
    get size() { return pool.size; },

  };
}
