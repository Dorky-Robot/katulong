/**
 * Terminal Pool Manager
 *
 * Manages a bounded pool of xterm.js Terminal instances, one per session.
 * Switching sessions toggles container visibility instead of clearing/resetting.
 * LRU eviction keeps memory bounded.
 */

import { Terminal } from "/vendor/xterm/xterm.esm.js";
import { WebLinksAddon } from "/vendor/xterm/addon-web-links.esm.js";
import { SearchAddon } from "/vendor/xterm/addon-search.esm.js";
import { ClipboardAddon } from "/vendor/xterm/addon-clipboard.esm.js";
import { WebglAddon } from "/vendor/xterm/addon-webgl.esm.js";
import { TERMINAL_COLS } from "/lib/terminal-config.js";

const MAX_POOL_SIZE = 5;
const FIXED_COLS = TERMINAL_COLS;

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

/** Calculate font size that fits FIXED_COLS in the given width. */
function fontSizeForWidth(term, width) {
  const charRatio = getCharRatio(term);
  const exactSize = width / (FIXED_COLS * charRatio);
  // Round DOWN to 0.5px steps so the terminal never overflows the container.
  return Math.max(6, Math.floor(exactSize * 2) / 2);
}

/**
 * Full init: set font size, cols, and rows for a terminal in its container.
 * Called once on activation/session switch — NOT on browser resize.
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
  // Only recalculate font when width meaningfully changes (>1px).
  // Height-only changes (keyboard accessory bar) should not affect font.
  const prevWidth = container._lastScaleWidth || 0;
  let fontSize = term.options.fontSize || 14;
  if (Math.abs(contentWidth - prevWidth) > 1) {
    container._lastScaleWidth = contentWidth;
    // Reserve 8px for symmetric left/right gap (CSS margin:auto centers
    // the .xterm-screen, so the remainder splits evenly on both sides).
    fontSize = fontSizeForWidth(term, contentWidth - 8);
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
  if (term.cols !== FIXED_COLS || term.rows !== rows) {
    term.resize(FIXED_COLS, rows);
    changed = true;
  }

  return { cols: FIXED_COLS, rows, changed };
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

    term.loadAddon(new WebLinksAddon());
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
      if (onResize && result?.changed) {
        onResize(sessionName, entry.term.cols, entry.term.rows);
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
    if (onResize && result?.changed) {
      onResize(sessionName, entry.term.cols, entry.term.rows);
    }
    return result?.changed ?? false;
  }

  /** Full init for all terminals. Notifies server for each that changed. */
  function scaleAll() {
    for (const [name, entry] of pool) {
      const result = scaleToFit(entry.term, entry.container);
      if (onResize && result?.changed) {
        onResize(name, entry.term.cols, entry.term.rows);
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
        if (onResize) {
          onResize(activeSession, active.term.cols, active.term.rows);
        }
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
    FIXED_COLS,
    get size() { return pool.size; },

  };
}
