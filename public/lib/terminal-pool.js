/**
 * Terminal Pool Manager
 *
 * Manages a bounded pool of xterm.js Terminal instances, one per session.
 * Switching sessions toggles container visibility instead of clearing/resetting.
 * LRU eviction keeps memory bounded.
 */

import { Terminal } from "/vendor/xterm/xterm.esm.js";
import { FitAddon } from "/vendor/xterm/addon-fit.esm.js";
import { WebLinksAddon } from "/vendor/xterm/addon-web-links.esm.js";
import { WebglAddon } from "/vendor/xterm/addon-webgl.esm.js";
import { SearchAddon } from "/vendor/xterm/addon-search.esm.js";
import { ClipboardAddon } from "/vendor/xterm/addon-clipboard.esm.js";

const MAX_POOL_SIZE = 5;

/**
 * Detect if a real GPU is available for WebGL rendering.
 * Cached on first call since GPU availability doesn't change at runtime.
 */
let _hasGPU = null;
function hasGPU() {
  if (_hasGPU !== null) return _hasGPU;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    _hasGPU = !!gl;
  } catch {
    _hasGPU = false;
  }
  return _hasGPU;
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
export function createTerminalPool({ parentEl, terminalOptions, onTerminalCreated }) {
  // sessionName -> { term, fit, searchAddon, container, lastUsed }
  const pool = new Map();
  let activeSession = null;

  function createEntry(sessionName) {
    // Evict LRU if at capacity
    if (pool.size >= MAX_POOL_SIZE) {
      let oldest = null;
      let oldestTime = Infinity;
      for (const [name, entry] of pool) {
        if (name === activeSession) continue; // never evict active
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldest = name;
        }
      }
      if (oldest) dispose(oldest);
    }

    const term = new Terminal(terminalOptions);
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(searchAddon);
    term.loadAddon(new ClipboardAddon());

    const container = document.createElement("div");
    container.className = "terminal-pane";
    container.dataset.session = sessionName;
    parentEl.appendChild(container);

    term.open(container);

    // WebGL addon — GPU-accelerated rendering with graceful fallback
    if (hasGPU()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // fallback to canvas
      }
    }

    const entry = { term, fit, searchAddon, container, sessionName, lastUsed: Date.now() };
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

  function activate(sessionName) {
    const entry = getOrCreate(sessionName);

    // Hide all panes, show the active one
    for (const [name, e] of pool) {
      e.container.classList.toggle("active", name === sessionName);
    }

    activeSession = sessionName;
    entry.lastUsed = Date.now();

    // Fit after visibility change (needs to be visible for correct dimensions).
    // Guard against the entry being disposed before the rAF fires.
    requestAnimationFrame(() => {
      if (!pool.has(sessionName)) return;
      entry.fit.fit();
      entry.term.focus();
      // Prevent the browser from scrolling the outer page when focus()
      // triggers scrollIntoView on the textarea helper.
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
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

  return {
    getOrCreate,
    activate,
    dispose,
    getActive,
    getActiveName,
    has,
    rename,
    forEach,
    get size() { return pool.size; },
  };
}
