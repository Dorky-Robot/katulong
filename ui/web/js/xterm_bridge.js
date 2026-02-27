/**
 * xterm.js Bridge for Dart interop
 *
 * Exposes terminal operations on window.xtermBridge for use via dart:js_interop.
 * Manages a single xterm.js Terminal instance with addons (fit, webgl, web-links, search, clipboard).
 *
 * Loaded as an ES module — imports from self-hosted vendor ESM bundles.
 */
import { Terminal } from '/vendor/xterm/xterm.esm.js';
import { FitAddon } from '/vendor/xterm/addon-fit.esm.js';
import { WebglAddon } from '/vendor/xterm/addon-webgl.esm.js';
import { WebLinksAddon } from '/vendor/xterm/addon-web-links.esm.js';
import { SearchAddon } from '/vendor/xterm/addon-search.esm.js';
import { ClipboardAddon } from '/vendor/xterm/addon-clipboard.esm.js';

let terminal = null;
let fitAddon = null;
let searchAddon = null;
let webglAddon = null;
let webLinksAddon = null;
let clipboardAddon = null;

window.xtermBridge = {
  /**
   * Initialize the terminal inside the given container element.
   * @param {string} containerId - DOM element ID to attach the terminal to
   */
  init(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('[xterm_bridge] Container not found:', containerId);
      return;
    }

    terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace",
      allowProposedApi: true,
      scrollback: 10000,
    });

    // Load addons
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    try {
      webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      webglAddon.onContextLost(() => {
        webglAddon.dispose();
        webglAddon = null;
      });
    } catch (e) {
      console.warn('[xterm_bridge] WebGL addon failed, falling back to canvas:', e);
    }

    try {
      webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(webLinksAddon);
    } catch (e) {
      console.warn('[xterm_bridge] Web links addon failed:', e);
    }

    try {
      searchAddon = new SearchAddon();
      terminal.loadAddon(searchAddon);
    } catch (e) {
      console.warn('[xterm_bridge] Search addon failed:', e);
    }

    try {
      clipboardAddon = new ClipboardAddon();
      terminal.loadAddon(clipboardAddon);
    } catch (e) {
      console.warn('[xterm_bridge] Clipboard addon failed:', e);
    }

    terminal.open(container);
    fitAddon.fit();
  },

  /** Write data to the terminal. */
  write(data) {
    if (terminal) terminal.write(data);
  },

  /** Resize the terminal to specific dimensions. */
  resize(cols, rows) {
    if (terminal) terminal.resize(cols, rows);
  },

  /** Fit the terminal to its container. */
  fit() {
    if (fitAddon) fitAddon.fit();
  },

  /** Focus the terminal. */
  focus() {
    if (terminal) terminal.focus();
  },

  /** Dispose the terminal and all addons. */
  dispose() {
    if (terminal) {
      terminal.dispose();
      terminal = null;
      fitAddon = null;
      searchAddon = null;
      webglAddon = null;
      webLinksAddon = null;
      clipboardAddon = null;
    }
  },

  /** Get current terminal dimensions. */
  getSize() {
    if (!terminal) return { cols: 80, rows: 24 };
    return { cols: terminal.cols, rows: terminal.rows };
  },

  /** Search for text in terminal buffer. */
  search(query, opts) {
    if (searchAddon) searchAddon.findNext(query, opts);
  },

  /** Search backwards. */
  searchPrevious(query, opts) {
    if (searchAddon) searchAddon.findPrevious(query, opts);
  },

  /** Clear search highlights. */
  clearSearch() {
    if (searchAddon) searchAddon.clearDecorations();
  },

  /**
   * Register callback for terminal data (user input).
   * @param {function} callback - Called with string data when user types
   */
  onData(callback) {
    if (terminal) terminal.onData(callback);
  },

  /**
   * Register callback for terminal resize events.
   * @param {function} callback - Called with {cols, rows} on resize
   */
  onResize(callback) {
    if (terminal) terminal.onResize(callback);
  },

  /**
   * Set terminal theme colors.
   * @param {object} themeObj - xterm.js ITheme object
   */
  setTheme(themeObj) {
    if (terminal) terminal.options.theme = themeObj;
  },

  /** Scroll to the bottom of the terminal. */
  scrollToBottom() {
    if (terminal) terminal.scrollToBottom();
  },

  /** Check if terminal is scrolled to the bottom. */
  isAtBottom() {
    if (!terminal) return true;
    return terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  },
};
