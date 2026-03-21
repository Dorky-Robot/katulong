import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// --- DOM/Browser mocks ---

function createMockElement(tag) {
  const styles = {};
  const classes = new Set();
  const children = [];
  const listeners = {};
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
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
      if (idx === -1) children.push(child); else children.splice(idx, 0, child);
      return child;
    },
    remove: () => { el.parentElement = null; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn); },
    querySelector: (sel) => {
      for (const c of children) {
        if (sel.startsWith(".") && c._classes?.has(sel.slice(1))) return c;
        if (c.querySelector) { const f = c.querySelector(sel); if (f) return f; }
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const results = [];
      for (const c of children) {
        if (sel.startsWith(".") && c._classes?.has(sel.slice(1))) results.push(c);
        if (c.querySelectorAll) results.push(...c.querySelectorAll(sel));
      }
      return results;
    },
    get firstChild() { return children[0] || null; },
    get nextSibling() { return null; },
    get parentElement() { return el._parentElement || null; },
    set parentElement(v) { el._parentElement = v; },
    get innerHTML() { return ""; },
    set innerHTML(v) { children.length = 0; },
    focus: () => {},
    blur: () => {},
    select: () => {},
    setAttribute: (k, v) => { el[`_attr_${k}`] = v; },
    getAttribute: (k) => el[`_attr_${k}`] || null,
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
          term: { cols: 80, rows: 24, refresh: mock.fn(), focus: mock.fn() },
          fit: { fit: mock.fn() },
          container: createMockElement("div"),
          sessionName: name,
        });
      }
      return pool.get(name);
    },
    forEach: (fn) => { for (const [name, entry] of pool) fn(name, entry); },
    activate: mock.fn(),
    has: (name) => pool.has(name),
    protect: mock.fn(),
    unprotect: mock.fn(),
    _pool: pool,
  };
}

function setupGlobals() {
  Object.defineProperty(globalThis, 'navigator', {
    value: { maxTouchPoints: 5, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" },
    writable: true, configurable: true,
  });
  globalThis.window = globalThis.window || globalThis;
  globalThis.window.innerWidth = 1024;
  if (!globalThis.window.addEventListener) globalThis.window.addEventListener = () => {};
  globalThis.window.matchMedia = (q) => ({ matches: q.includes("landscape"), addEventListener: () => {} });
  globalThis.screen = { orientation: { type: "landscape-primary", addEventListener: () => {} }, width: 1024, height: 768 };
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = (tag) => createMockElement(tag);
  globalThis.document.getElementById = () => null;
  globalThis.document.querySelector = () => null;
  globalThis.requestAnimationFrame = (fn) => fn();
  const storage = {};
  globalThis.sessionStorage = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v; },
    removeItem: (k) => { delete storage[k]; },
  };
}

async function importCarousel() {
  const url = new URL('../public/lib/card-carousel.js', import.meta.url);
  const mod = await import(url.href + '?t=' + Date.now() + Math.random());
  return mod.createCardCarousel;
}

describe('card-carousel', () => {
  let createCardCarousel;
  let container;
  let terminalPool;
  let sendResize;
  let onFocusChange;
  let onCardDismissed;
  let onAddClick;
  let carousel;

  beforeEach(async () => {
    setupGlobals();
    createCardCarousel = await importCarousel();
    container = createMockElement("div");
    terminalPool = createMockTerminalPool();
    sendResize = mock.fn();
    onFocusChange = mock.fn();
    onCardDismissed = mock.fn();
    onAddClick = mock.fn();
    carousel = createCardCarousel({
      container, terminalPool, sendResize,
      onFocusChange, onCardDismissed, onAddClick,
    });
  });

  describe('initial state', () => {
    it('starts inactive', () => {
      assert.strictEqual(carousel.isActive(), false);
    });

    it('has no cards', () => {
      assert.deepStrictEqual(carousel.getCards(), []);
    });

    it('has no focused card', () => {
      assert.strictEqual(carousel.getFocusedCard(), null);
    });
  });

  describe('activate()', () => {
    it('sets active', () => {
      carousel.activate(["a", "b"], "a");
      assert.strictEqual(carousel.isActive(), true);
    });

    it('sets cards in order', () => {
      carousel.activate(["a", "b", "c"], "b");
      assert.deepStrictEqual(carousel.getCards(), ["a", "b", "c"]);
    });

    it('sets focused card', () => {
      carousel.activate(["a", "b"], "b");
      assert.strictEqual(carousel.getFocusedCard(), "b");
    });

    it('sets data-carousel attribute on container', () => {
      carousel.activate(["a"], "a");
      assert.strictEqual(container.dataset.carousel, "true");
    });

    it('creates terminal entries in pool', () => {
      carousel.activate(["a", "b"], "a");
      assert.ok(terminalPool.get("a"));
      assert.ok(terminalPool.get("b"));
    });

    it('protects all cards from LRU eviction', () => {
      carousel.activate(["a", "b"], "a");
      assert.strictEqual(terminalPool.protect.mock.callCount(), 2);
    });

    it('calls sendResize for visible cards', () => {
      carousel.activate(["a", "b"], "a");
      assert.ok(sendResize.mock.callCount() >= 2);
    });
  });

  describe('deactivate()', () => {
    beforeEach(() => {
      carousel.activate(["a", "b"], "a");
    });

    it('sets inactive', () => {
      carousel.deactivate();
      assert.strictEqual(carousel.isActive(), false);
    });

    it('clears cards', () => {
      carousel.deactivate();
      assert.deepStrictEqual(carousel.getCards(), []);
    });

    it('clears focused card', () => {
      carousel.deactivate();
      assert.strictEqual(carousel.getFocusedCard(), null);
    });

    it('removes data-carousel attribute', () => {
      carousel.deactivate();
      assert.strictEqual(container.dataset.carousel, undefined);
    });

    it('unprotects all cards', () => {
      carousel.deactivate();
      assert.ok(terminalPool.unprotect.mock.callCount() >= 2);
    });
  });

  describe('addCard()', () => {
    beforeEach(() => {
      carousel.activate(["a"], "a");
    });

    it('adds a card to the end', () => {
      carousel.addCard("b");
      assert.deepStrictEqual(carousel.getCards(), ["a", "b"]);
    });

    it('creates the terminal in the pool', () => {
      carousel.addCard("b");
      assert.ok(terminalPool.get("b"));
    });

    it('protects the new card', () => {
      const before = terminalPool.protect.mock.callCount();
      carousel.addCard("b");
      assert.ok(terminalPool.protect.mock.callCount() > before);
    });

    it('does not add duplicate cards', () => {
      carousel.addCard("a");
      assert.deepStrictEqual(carousel.getCards(), ["a"]);
    });
  });

  describe('removeCard()', () => {
    beforeEach(() => {
      carousel.activate(["a", "b", "c"], "b");
    });

    it('removes the card', () => {
      carousel.removeCard("b");
      assert.deepStrictEqual(carousel.getCards(), ["a", "c"]);
    });

    it('fires onCardDismissed', () => {
      carousel.removeCard("b");
      assert.strictEqual(onCardDismissed.mock.callCount(), 1);
    });

    it('shifts focus to adjacent card when focused card is removed', () => {
      carousel.removeCard("b");
      // Should focus "c" (next) or "a" (previous)
      assert.ok(["a", "c"].includes(carousel.getFocusedCard()));
    });

    it('deactivates when last card is removed', () => {
      carousel.removeCard("a");
      carousel.removeCard("b");
      carousel.removeCard("c");
      assert.strictEqual(carousel.isActive(), false);
    });

    it('unprotects the removed card', () => {
      const before = terminalPool.unprotect.mock.callCount();
      carousel.removeCard("b");
      assert.ok(terminalPool.unprotect.mock.callCount() > before);
    });
  });

  describe('focusCard()', () => {
    beforeEach(() => {
      carousel.activate(["a", "b"], "a");
    });

    it('changes the focused card', () => {
      carousel.focusCard("b");
      assert.strictEqual(carousel.getFocusedCard(), "b");
    });

    it('fires onFocusChange', () => {
      carousel.focusCard("b");
      assert.strictEqual(onFocusChange.mock.callCount(), 1);
      assert.strictEqual(onFocusChange.mock.calls[0].arguments[0], "b");
    });

    it('does not fire onFocusChange if already focused', () => {
      carousel.focusCard("a");
      assert.strictEqual(onFocusChange.mock.callCount(), 0);
    });

    it('ignores unknown sessions', () => {
      carousel.focusCard("unknown");
      assert.strictEqual(carousel.getFocusedCard(), "a");
    });
  });

  describe('renameCard()', () => {
    beforeEach(() => {
      carousel.activate(["a", "b"], "a");
    });

    it('updates the card name in the list', () => {
      carousel.renameCard("a", "a-renamed");
      assert.deepStrictEqual(carousel.getCards(), ["a-renamed", "b"]);
    });

    it('updates focused card if renamed', () => {
      carousel.renameCard("a", "a-renamed");
      assert.strictEqual(carousel.getFocusedCard(), "a-renamed");
    });

    it('preserves order', () => {
      carousel.renameCard("b", "b-renamed");
      assert.deepStrictEqual(carousel.getCards(), ["a", "b-renamed"]);
    });
  });

  describe('persistence', () => {
    it('saves state on activate', () => {
      carousel.activate(["a", "b"], "a");
      const saved = JSON.parse(sessionStorage.getItem("katulong-carousel"));
      assert.deepStrictEqual(saved.cards, ["a", "b"]);
      assert.strictEqual(saved.focused, "a");
    });

    it('saves state on addCard', () => {
      carousel.activate(["a"], "a");
      carousel.addCard("b");
      const saved = JSON.parse(sessionStorage.getItem("katulong-carousel"));
      assert.deepStrictEqual(saved.cards, ["a", "b"]);
    });

    it('clears state on deactivate', () => {
      carousel.activate(["a"], "a");
      carousel.deactivate();
      assert.strictEqual(sessionStorage.getItem("katulong-carousel"), null);
    });

    it('restore() returns saved state', () => {
      carousel.activate(["a", "b"], "b");
      const restored = carousel.restore();
      assert.deepStrictEqual(restored.sessions, ["a", "b"]);
      assert.strictEqual(restored.focused, "b");
    });

    it('restore() returns null when no saved state', () => {
      assert.strictEqual(carousel.restore(), null);
    });
  });
});
