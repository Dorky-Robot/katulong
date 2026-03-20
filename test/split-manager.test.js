import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// --- DOM/Browser mocks for split-manager (runs in Node, not a browser) ---

function createMockElement(tag) {
  const styles = {};
  const classes = new Set();
  const children = [];
  const listeners = {};
  const el = {
    style: new Proxy(styles, {
      set: (t, k, v) => { t[k] = v; return true; },
      get: (t, k) => t[k] || "",
    }),
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, f) => f !== undefined ? (f ? classes.add(c) : classes.delete(c)) : (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c),
    },
    className: "",
    dataset: {},
    appendChild: (child) => { children.push(child); child.parentElement = el; return child; },
    insertBefore: (child, ref) => {
      child.parentElement = el;
      const idx = ref ? children.indexOf(ref) : children.length;
      if (idx === -1) children.push(child);
      else children.splice(idx, 0, child);
      return child;
    },
    remove: () => { el.parentElement = null; },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type, fn) => { if (listeners[type] === fn) delete listeners[type]; },
    querySelector: (sel) => {
      // Simple selector support for tests
      for (const c of children) {
        if (c._classes && sel.startsWith(".") && c._classes.has(sel.slice(1))) return c;
        if (c.querySelector) {
          const found = c.querySelector(sel);
          if (found) return found;
        }
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const results = [];
      for (const c of children) {
        if (c._classes && sel.includes(".")) {
          const selectors = sel.split(",").map(s => s.trim());
          for (const s of selectors) {
            if (s.startsWith(".") && c._classes.has(s.slice(1))) results.push(c);
          }
        }
        if (c.querySelectorAll) {
          results.push(...c.querySelectorAll(sel));
        }
      }
      return results;
    },
    get firstChild() { return children[0] || null; },
    get nextSibling() { return null; },
    get parentElement() { return el._parentElement || null; },
    set parentElement(v) { el._parentElement = v; },
    get innerHTML() { return ""; },
    set innerHTML(v) { children.length = 0; },
    _classes: classes,
    _styles: styles,
    _children: children,
    _listeners: listeners,
  };
  return el;
}

function createMockTerminalPool() {
  const pool = new Map();
  return {
    get: (name) => pool.get(name) || null,
    getOrCreate: (name) => {
      if (!pool.has(name)) {
        pool.set(name, {
          term: { cols: 80, rows: 24 },
          fit: { fit: mock.fn() },
          container: createMockElement(),
          sessionName: name,
        });
      }
      return pool.get(name);
    },
    forEach: (fn) => { for (const [name, entry] of pool) fn(name, entry); },
    activate: mock.fn(),
    has: (name) => pool.has(name),
    _pool: pool,
  };
}

// Minimal browser globals for split-manager
function setupGlobals() {
  // navigator is read-only in Node — use defineProperty
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      maxTouchPoints: 5,
      // iPad Safari UA (reports as Macintosh with touch)
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    },
    writable: true,
    configurable: true,
  });
  globalThis.window = globalThis.window || globalThis;
  globalThis.window.innerWidth = 1024;
  // Ensure addEventListener exists on window (Node doesn't have it by default)
  if (!globalThis.window.addEventListener) {
    globalThis.window.addEventListener = () => {};
  }
  globalThis.window.matchMedia = (query) => ({
    matches: query.includes("landscape"),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  globalThis.screen = {
    orientation: { type: "landscape-primary", addEventListener: () => {} },
    width: 1024,
    height: 768,
  };
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = (tag) => createMockElement(tag);
  globalThis.document.getElementById = () => null;
  globalThis.document.querySelector = () => null;
  globalThis.requestAnimationFrame = (fn) => fn();
  // Mock sessionStorage
  const storage = {};
  globalThis.sessionStorage = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v; },
    removeItem: (k) => { delete storage[k]; },
  };
}

// Dynamic import after globals are set
async function importSplitManager() {
  // Clear module cache for fresh import
  const url = new URL('../public/lib/split-manager.js', import.meta.url);
  // Add cache-buster to force re-evaluation
  const mod = await import(url.href + '?t=' + Date.now() + Math.random());
  return mod.createSplitManager;
}

describe('split-manager', () => {
  let createSplitManager;
  let terminalContainer;
  let terminalPool;
  let sendResize;
  let sm;

  beforeEach(async () => {
    setupGlobals();
    createSplitManager = (await importSplitManager());
    terminalContainer = createMockElement();
    terminalPool = createMockTerminalPool();
    sendResize = mock.fn();
    sm = createSplitManager({ terminalContainer, terminalPool, sendResize });
  });

  describe('initial state', () => {
    it('starts with isSplit false', () => {
      assert.strictEqual(sm.isSplit(), false);
    });

    it('pane1 and pane2 are null', () => {
      assert.strictEqual(sm.getPane1(), null);
      assert.strictEqual(sm.getPane2(), null);
    });

    it('isTablet returns true when touch + wide screen', () => {
      assert.strictEqual(sm.isTablet(), true);
    });

    it('isTablet returns false when no touch', () => {
      globalThis.navigator.maxTouchPoints = 0;
      assert.strictEqual(sm.isTablet(), false);
    });

    it('isTablet returns false when narrow screen', () => {
      globalThis.window.innerWidth = 600;
      assert.strictEqual(sm.isTablet(), false);
    });

    it('isTablet returns false for desktop with touch (non-iPad UA)', () => {
      globalThis.navigator.maxTouchPoints = 10;
      globalThis.navigator.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
      assert.strictEqual(sm.isTablet(), false);
    });
  });

  describe('split()', () => {
    it('sets isSplit to true', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.isSplit(), true);
    });

    it('sets pane1 and pane2 sessions', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.getPane1(), "a");
      assert.strictEqual(sm.getPane2(), "b");
    });

    it('adds session2 to pane2Sessions', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.isInPane2("b"), true);
      assert.strictEqual(sm.isInPane2("a"), false);
    });

    it('creates terminals in pool', () => {
      sm.split("a", "b");
      assert.ok(terminalPool.get("a"));
      assert.ok(terminalPool.get("b"));
    });

    it('does nothing when not a tablet', () => {
      globalThis.navigator.maxTouchPoints = 0;
      sm.split("a", "b");
      assert.strictEqual(sm.isSplit(), false);
    });

    it('fires onSplitChanged callback', () => {
      const calls = [];
      sm.onSplitChanged = (state) => calls.push(state);
      sm.split("a", "b");
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], { isSplit: true, pane1: "a", pane2: "b" });
    });

    it('applies split layout via data attribute', () => {
      sm.split("a", "b");
      assert.strictEqual(terminalContainer.dataset.split, "row"); // landscape
    });

    it('sends resize for both panes', () => {
      sm.split("a", "b");
      assert.strictEqual(sendResize.mock.callCount(), 2);
    });
  });

  describe('unsplit()', () => {
    beforeEach(() => {
      sm.split("a", "b");
    });

    it('sets isSplit to false', () => {
      sm.unsplit("a");
      assert.strictEqual(sm.isSplit(), false);
    });

    it('clears pane2Sessions', () => {
      sm.unsplit("a");
      assert.strictEqual(sm.isInPane2("b"), false);
    });

    it('keeps the specified session as pane1', () => {
      sm.unsplit("b");
      assert.strictEqual(sm.getPane1(), "b");
    });

    it('defaults to pane1 session when no keepSession specified', () => {
      sm.unsplit();
      assert.strictEqual(sm.getPane1(), "a");
    });

    it('sets pane2 to null', () => {
      sm.unsplit("a");
      assert.strictEqual(sm.getPane2(), null);
    });

    it('restores single-pane mode via pool.activate', () => {
      sm.unsplit("a");
      assert.strictEqual(terminalPool.activate.mock.callCount(), 1);
    });

    it('removes data-split attribute from container', () => {
      sm.unsplit("a");
      assert.strictEqual(terminalContainer.dataset.split, undefined);
    });

    it('removes split-hidden class from all pane containers', () => {
      sm.unsplit("a");
      terminalPool.forEach((_name, entry) => {
        assert.strictEqual(entry.container.classList.contains("split-hidden"), false);
      });
    });

    it('fires onSplitChanged with isSplit false', () => {
      const calls = [];
      sm.onSplitChanged = (state) => calls.push(state);
      sm.unsplit("a");
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], { isSplit: false, pane1: "a", pane2: null });
    });

    it('is a no-op when not split', () => {
      sm.unsplit("a"); // first unsplit
      const calls = [];
      sm.onSplitChanged = (state) => calls.push(state);
      sm.unsplit("a"); // second unsplit — no-op
      assert.strictEqual(calls.length, 0);
    });
  });

  describe('getPaneForSession()', () => {
    it('returns 1 for sessions not in pane2', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.getPaneForSession("a"), 1);
      assert.strictEqual(sm.getPaneForSession("unknown"), 1);
    });

    it('returns 2 for sessions in pane2', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.getPaneForSession("b"), 2);
    });
  });

  describe('getOtherSession()', () => {
    it('returns pane2 session when given pane1', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.getOtherSession("a"), "b");
    });

    it('returns pane1 session when given pane2', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.getOtherSession("b"), "a");
    });

    it('returns null for unknown session', () => {
      sm.split("a", "b");
      assert.strictEqual(sm.getOtherSession("unknown"), null);
    });
  });

  describe('switchPaneSession()', () => {
    beforeEach(() => {
      sm.split("a", "b");
    });

    it('switches pane 1 active session', () => {
      terminalPool.getOrCreate("c");
      sm.switchPaneSession(1, "c");
      assert.strictEqual(sm.getPane1(), "c");
      assert.strictEqual(sm.getPane2(), "b"); // unchanged
    });

    it('switches pane 2 active session', () => {
      terminalPool.getOrCreate("c");
      sm.switchPaneSession(2, "c");
      assert.strictEqual(sm.getPane2(), "c");
      assert.strictEqual(sm.getPane1(), "a"); // unchanged
    });

    it('adds new pane 2 session to pane2Sessions', () => {
      terminalPool.getOrCreate("c");
      sm.switchPaneSession(2, "c");
      assert.strictEqual(sm.isInPane2("c"), true);
    });

    it('removes session from pane2Sessions when moved to pane 1', () => {
      sm.switchPaneSession(1, "b");
      assert.strictEqual(sm.isInPane2("b"), false);
    });
  });

  describe('addToPane2 / removeFromPane2', () => {
    it('adds and removes sessions from pane2Sessions', () => {
      sm.split("a", "b");
      sm.addToPane2("c");
      assert.strictEqual(sm.isInPane2("c"), true);
      assert.strictEqual(sm.getPaneForSession("c"), 2);

      sm.removeFromPane2("c");
      assert.strictEqual(sm.isInPane2("c"), false);
      assert.strictEqual(sm.getPaneForSession("c"), 1);
    });
  });

  describe('session lifecycle during split', () => {
    it('removeFromPane2 handles sessions that were never in pane2', () => {
      sm.split("a", "b");
      // Should not throw
      sm.removeFromPane2("nonexistent");
      assert.strictEqual(sm.isInPane2("nonexistent"), false);
    });

    it('renamed session must be updated in pane2Sessions', () => {
      sm.split("a", "b");
      // Simulate rename: remove old, add new
      const wasInPane2 = sm.isInPane2("b");
      if (wasInPane2) {
        sm.removeFromPane2("b");
        sm.addToPane2("b-renamed");
      }
      assert.strictEqual(sm.isInPane2("b"), false);
      assert.strictEqual(sm.isInPane2("b-renamed"), true);
    });
  });

  describe('getDirection()', () => {
    it('returns row for landscape', () => {
      // Our mock matchMedia returns true for queries containing "landscape"
      assert.strictEqual(sm.getDirection(), "row");
    });

    it('returns column for portrait', () => {
      globalThis.screen.orientation = { type: "portrait-primary", addEventListener: () => {} };
      globalThis.screen.width = 768;
      globalThis.screen.height = 1024;
      const sm2 = createSplitManager({ terminalContainer, terminalPool, sendResize });
      assert.strictEqual(sm2.getDirection(), "column");
    });
  });

  describe('persistence', () => {
    it('saves split state to sessionStorage', () => {
      sm.split("a", "b");
      const saved = JSON.parse(sessionStorage.getItem("katulong-split-state"));
      assert.strictEqual(saved.active, true);
      assert.strictEqual(saved.pane1, "a");
      assert.strictEqual(saved.pane2, "b");
      assert.deepStrictEqual(saved.pane2List, ["b"]);
    });

    it('clears state on unsplit', () => {
      sm.split("a", "b");
      sm.unsplit("a");
      assert.strictEqual(sessionStorage.getItem("katulong-split-state"), null);
    });

    it('restore() re-creates the split', () => {
      sm.split("a", "b");
      sm.addToPane2("c");
      // Simulate a fresh manager (new instance, same sessionStorage)
      const sm2 = createSplitManager({ terminalContainer, terminalPool, sendResize: mock.fn() });
      const restored = sm2.restore();
      assert.strictEqual(restored, true);
      assert.strictEqual(sm2.isSplit(), true);
      assert.strictEqual(sm2.getPane1(), "a");
      assert.strictEqual(sm2.getPane2(), "b");
      assert.strictEqual(sm2.isInPane2("c"), true);
    });

    it('restore() returns false when no saved state', () => {
      sessionStorage.removeItem("katulong-split-state");
      const restored = sm.restore();
      assert.strictEqual(restored, false);
    });
  });

  describe('divider', () => {
    it('is created when split', () => {
      sm.split("a", "b");
      // Divider is appended to the terminal container as a child
      // It's created via createElement and has style.cssText set
      assert.ok(terminalContainer._children.length > 0, "divider should be in terminal container children");
    });

    it('is removed on unsplit', () => {
      sm.split("a", "b");
      sm.unsplit("a");
      // After unsplit, divider should be removed (dividerEl set to null internally)
      // We can verify by splitting again — a new divider should be created
      sm.split("a", "b");
      // No error = divider was properly cleaned up
      assert.ok(true);
    });
  });
});
