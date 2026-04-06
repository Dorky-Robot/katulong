import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// --- DOM/Browser mocks ---

function createMockElement(tag) {
  const styles = {};
  const classes = new Set();
  const children = [];
  const listeners = {};
  const styleTarget = {
    setProperty: (k, v) => { styles[k] = v; },
    removeProperty: (k) => { delete styles[k]; },
  };
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
    style: new Proxy(styleTarget, {
      set: (_t, k, v) => { styles[k] = v; return true; },
      get: (t, k) => (k in t ? t[k] : (styles[k] || "")),
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
    get previousElementSibling() { return null; },
    get nextElementSibling() { return null; },
    get parentElement() { return el._parentElement || null; },
    set parentElement(v) { el._parentElement = v; },
    get innerHTML() { return ""; },
    set innerHTML(v) { children.length = 0; },
    focus: () => {},
    blur: () => {},
    select: () => {},
    setAttribute: (k, v) => { el[`_attr_${k}`] = v; },
    getAttribute: (k) => el[`_attr_${k}`] || null,
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    get offsetHeight() { return 100; },
    _classes: classes,
    _styles: styles,
    _children: children,
    _listeners: listeners,
  };
  return el;
}

/** Create a mock tile that tracks lifecycle calls. */
function createMockTile(id) {
  return {
    type: "mock",
    sessionName: id,
    mount: mock.fn(),
    unmount: mock.fn(),
    focus: mock.fn(),
    blur: mock.fn(),
    resize: mock.fn(),
    getTitle: () => id,
    getIcon: () => "terminal-window",
    serialize: () => ({ type: "mock", sessionName: id }),
  };
}

/** Create tile entries (id + tile) for the carousel. */
function makeTiles(...names) {
  return names.map(n => ({ id: n, tile: createMockTile(n) }));
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
  globalThis.localStorage = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v; },
    removeItem: (k) => { delete storage[k]; },
  };
}

async function importCarousel() {
  const url = new URL('../public/lib/card-carousel.js', import.meta.url);
  const mod = await import(url.href + '?t=' + Date.now() + Math.random());
  return { createCardCarousel: mod.createCardCarousel, isCarouselDevice: mod.isCarouselDevice };
}

describe('isCarouselDevice()', () => {
  it('returns true for all platforms (unified carousel UI)', async () => {
    setupGlobals();
    Object.defineProperty(globalThis, 'navigator', {
      value: { maxTouchPoints: 0, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      writable: true, configurable: true,
    });
    const { isCarouselDevice } = await importCarousel();
    assert.strictEqual(isCarouselDevice(), true);
  });
});

describe('card-carousel', () => {
  let createCardCarousel;
  let container;
  let onFocusChange;
  let onCardDismissed;
  let onAllCardsDismissed;
  let carousel;

  beforeEach(async () => {
    setupGlobals();
    const mod = await importCarousel();
    createCardCarousel = mod.createCardCarousel;
    container = createMockElement("div");
    onFocusChange = mock.fn();
    onCardDismissed = mock.fn();
    onAllCardsDismissed = mock.fn();
    carousel = createCardCarousel({
      container,
      onFocusChange,
      onCardDismissed,
      onAllCardsDismissed,
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
      carousel.activate(makeTiles("a", "b"), "a");
      assert.strictEqual(carousel.isActive(), true);
    });

    it('sets cards in order', () => {
      carousel.activate(makeTiles("a", "b", "c"), "b");
      assert.deepStrictEqual(carousel.getCards(), ["a", "b", "c"]);
    });

    it('sets focused card', () => {
      carousel.activate(makeTiles("a", "b"), "b");
      assert.strictEqual(carousel.getFocusedCard(), "b");
    });

    it('sets data-carousel attribute on container', () => {
      carousel.activate(makeTiles("a"), "a");
      assert.strictEqual(container.dataset.carousel, "true");
    });

    it('mounts tiles', () => {
      const tiles = makeTiles("a", "b");
      carousel.activate(tiles, "a");
      assert.strictEqual(tiles[0].tile.mount.mock.callCount(), 1);
      assert.strictEqual(tiles[1].tile.mount.mock.callCount(), 1);
    });

    it('focuses the initial tile', () => {
      const tiles = makeTiles("a", "b");
      carousel.activate(tiles, "a");
      assert.strictEqual(tiles[0].tile.focus.mock.callCount(), 1);
    });

    it('fires onFocusChange for the initial focused tile', () => {
      carousel.activate(makeTiles("a", "b"), "b");
      assert.ok(onFocusChange.mock.callCount() >= 1);
      const lastCall = onFocusChange.mock.calls[onFocusChange.mock.callCount() - 1];
      assert.strictEqual(lastCall.arguments[0], "b");
    });

    it('fires onFocusChange with first tile when no focused specified', () => {
      carousel.activate(makeTiles("x", "y"));
      assert.ok(onFocusChange.mock.callCount() >= 1);
      const lastCall = onFocusChange.mock.calls[onFocusChange.mock.callCount() - 1];
      assert.strictEqual(lastCall.arguments[0], "x");
    });
  });

  describe('deactivate()', () => {
    let tiles;
    beforeEach(() => {
      tiles = makeTiles("a", "b");
      carousel.activate(tiles, "a");
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

    it('unmounts all tiles', () => {
      carousel.deactivate();
      assert.strictEqual(tiles[0].tile.unmount.mock.callCount(), 1);
      assert.strictEqual(tiles[1].tile.unmount.mock.callCount(), 1);
    });
  });

  describe('addCard()', () => {
    beforeEach(() => {
      carousel.activate(makeTiles("a"), "a");
    });

    it('adds a card to the end', () => {
      carousel.addCard("b", createMockTile("b"));
      assert.deepStrictEqual(carousel.getCards(), ["a", "b"]);
    });

    it('mounts the new tile', () => {
      const tile = createMockTile("b");
      carousel.addCard("b", tile);
      assert.strictEqual(tile.mount.mock.callCount(), 1);
    });

    it('does not add duplicate cards', () => {
      carousel.addCard("a", createMockTile("a"));
      assert.deepStrictEqual(carousel.getCards(), ["a"]);
    });
  });

  describe('removeCard()', () => {
    let tiles;
    beforeEach(() => {
      tiles = makeTiles("a", "b", "c");
      carousel.activate(tiles, "b");
    });

    it('removes the card', () => {
      carousel.removeCard("b");
      assert.deepStrictEqual(carousel.getCards(), ["a", "c"]);
    });

    it('fires onCardDismissed', () => {
      carousel.removeCard("b");
      assert.strictEqual(onCardDismissed.mock.callCount(), 1);
    });

    it('unmounts the removed tile', () => {
      carousel.removeCard("b");
      assert.strictEqual(tiles[1].tile.unmount.mock.callCount(), 1);
    });

    it('shifts focus to adjacent card when focused card is removed', () => {
      carousel.removeCard("b");
      assert.ok(["a", "c"].includes(carousel.getFocusedCard()));
    });

    it('deactivates when last card is removed', () => {
      carousel.removeCard("a");
      carousel.removeCard("b");
      carousel.removeCard("c");
      assert.strictEqual(carousel.isActive(), false);
    });
  });

  describe('focusCard()', () => {
    let tiles;
    beforeEach(() => {
      tiles = makeTiles("a", "b");
      carousel.activate(tiles, "a");
    });

    it('changes the focused card', () => {
      carousel.focusCard("b");
      assert.strictEqual(carousel.getFocusedCard(), "b");
    });

    it('fires onFocusChange', () => {
      const before = onFocusChange.mock.callCount();
      carousel.focusCard("b");
      assert.strictEqual(onFocusChange.mock.callCount(), before + 1);
      assert.strictEqual(onFocusChange.mock.calls[onFocusChange.mock.callCount() - 1].arguments[0], "b");
    });

    it('calls focus on the new tile and blur on the old', () => {
      carousel.focusCard("b");
      assert.strictEqual(tiles[0].tile.blur.mock.callCount(), 1);
      assert.ok(tiles[1].tile.focus.mock.callCount() >= 1);
    });

    it('does not fire onFocusChange if already focused', () => {
      const before = onFocusChange.mock.callCount();
      carousel.focusCard("a");
      assert.strictEqual(onFocusChange.mock.callCount(), before);
    });

    it('ignores unknown tile IDs', () => {
      carousel.focusCard("unknown");
      assert.strictEqual(carousel.getFocusedCard(), "a");
    });
  });

  describe('renameCard()', () => {
    beforeEach(() => {
      carousel.activate(makeTiles("a", "b"), "a");
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

  describe('getTile()', () => {
    it('returns the tile for a given ID', () => {
      const tiles = makeTiles("a");
      carousel.activate(tiles, "a");
      const tile = carousel.getTile("a");
      assert.strictEqual(tile.type, "mock");
    });

    it('returns null for unknown ID', () => {
      carousel.activate(makeTiles("a"), "a");
      assert.strictEqual(carousel.getTile("unknown"), null);
    });
  });

  describe('findCard()', () => {
    it('finds a card by predicate', () => {
      carousel.activate(makeTiles("a", "b"), "a");
      const found = carousel.findCard((tile) => tile.sessionName === "b");
      assert.strictEqual(found, "b");
    });

    it('returns null when no match', () => {
      carousel.activate(makeTiles("a"), "a");
      const found = carousel.findCard((tile) => tile.sessionName === "z");
      assert.strictEqual(found, null);
    });
  });

  describe('reorderCards()', () => {
    beforeEach(() => {
      carousel.activate(makeTiles("a", "b", "c"), "b");
    });

    it('reorders cards to match the given order', () => {
      carousel.reorderCards(["c", "a", "b"]);
      assert.deepStrictEqual(carousel.getCards(), ["c", "a", "b"]);
    });

    it('preserves focused card after reorder', () => {
      carousel.reorderCards(["c", "a", "b"]);
      assert.strictEqual(carousel.getFocusedCard(), "b");
    });

    it('ignores unknown IDs in the ordered list', () => {
      carousel.reorderCards(["c", "unknown", "a", "b"]);
      assert.deepStrictEqual(carousel.getCards(), ["c", "a", "b"]);
    });

    it('appends cards not in the ordered list to the end', () => {
      carousel.reorderCards(["c", "a"]);
      assert.deepStrictEqual(carousel.getCards(), ["c", "a", "b"]);
    });

    it('is a no-op when order has not changed', () => {
      carousel.reorderCards(["a", "b", "c"]);
      assert.deepStrictEqual(carousel.getCards(), ["a", "b", "c"]);
    });
  });

  describe('persistence', () => {
    it('saves state on activate', () => {
      carousel.activate(makeTiles("a", "b"), "a");
      const saved = JSON.parse(localStorage.getItem("katulong-carousel"));
      assert.strictEqual(saved.cards.length, 2);
      assert.strictEqual(saved.cards[0].id, "a");
      assert.strictEqual(saved.cards[1].id, "b");
      assert.strictEqual(saved.focused, "a");
    });

    it('saves state on addCard', () => {
      carousel.activate(makeTiles("a"), "a");
      carousel.addCard("b", createMockTile("b"));
      const saved = JSON.parse(localStorage.getItem("katulong-carousel"));
      assert.strictEqual(saved.cards.length, 2);
    });

    it('clears state on deactivate', () => {
      carousel.activate(makeTiles("a"), "a");
      carousel.deactivate();
      assert.strictEqual(localStorage.getItem("katulong-carousel"), null);
    });

    it('restore() returns saved state', () => {
      carousel.activate(makeTiles("a", "b"), "b");
      const restored = carousel.restore();
      assert.strictEqual(restored.tiles.length, 2);
      assert.strictEqual(restored.focused, "b");
    });

    it('restore() returns null when no saved state', () => {
      assert.strictEqual(carousel.restore(), null);
    });

    it('restore() handles legacy string array format', () => {
      localStorage.setItem("katulong-carousel", JSON.stringify({
        cards: ["x", "y"],
        focused: "y",
      }));
      const restored = carousel.restore();
      assert.strictEqual(restored.tiles.length, 2);
      assert.strictEqual(restored.tiles[0].type, "terminal");
      assert.strictEqual(restored.tiles[0].sessionName, "x");
      assert.strictEqual(restored.focused, "y");
    });

    it('persists per-card width across a save → re-activate cycle', () => {
      // Activate, resize a card via the exposed handles, save via
      // the normal post-resize hook.
      const first = makeTiles("a", "b");
      carousel.activate(first, "a");
      const saved = JSON.parse(localStorage.getItem("katulong-carousel"));
      assert.ok(saved.cards.every(c => c.cardWidth === undefined),
        "no cardWidth until one is set");

      // Simulate a resize on card "a" by writing the saved JSON directly
      // with a cardWidth, then re-activating as if after a refresh.
      saved.cards[0].cardWidth = 512;
      localStorage.setItem("katulong-carousel", JSON.stringify(saved));

      // Re-create the carousel (fresh instance, same localStorage)
      carousel = createCardCarousel({
        container,
        onFocusChange,
        onCardDismissed,
        onAllCardsDismissed,
      });

      // Activate with plain tiles that DO NOT carry cardWidth — this
      // matches what app.js does on refresh via makeTerminalTile().
      carousel.activate(makeTiles("a", "b"), "a");

      // The carousel should have looked up the saved width and
      // persisted it back so the next save() round-trip preserves it.
      const afterReactivate = JSON.parse(localStorage.getItem("katulong-carousel"));
      assert.strictEqual(afterReactivate.cards[0].cardWidth, 512,
        "saved width should survive activate() even when tiles omit cardWidth");
      assert.strictEqual(afterReactivate.cards[1].cardWidth, undefined,
        "tiles without a saved width should remain default");
    });

    it('explicit cardWidth on an incoming tile wins over saved width', () => {
      // Seed localStorage with a saved width for tile "a".
      localStorage.setItem("katulong-carousel", JSON.stringify({
        cards: [{ id: "a", type: "mock", cardWidth: 400 }],
        focused: "a",
      }));

      // Activate with an explicit cardWidth — this matches the delayed
      // restore path in app.js that reconstructs tiles from saved state.
      const tiles = [{ id: "a", tile: createMockTile("a"), cardWidth: 700 }];
      carousel.activate(tiles, "a");

      const saved = JSON.parse(localStorage.getItem("katulong-carousel"));
      assert.strictEqual(saved.cards[0].cardWidth, 700,
        "explicit cardWidth should override the saved localStorage width");
    });

    it('ignores tampered/corrupt cardWidth values in localStorage', () => {
      // Seed localStorage with a mix of invalid cardWidth values that
      // can actually survive JSON round-tripping. None should be
      // restored into handles — they should all be silently dropped,
      // leaving each card at its default.
      //
      // Note: NaN and Infinity cannot reach this path because
      // JSON.stringify serializes them as null. They are covered
      // by the defense-in-depth guard in tile-resize.restore() and
      // tested directly in test/tile-resize.test.js.
      const invalidCases = [
        { id: "a", type: "mock", cardWidth: "not a number" },
        { id: "b", type: "mock", cardWidth: -10 },
        { id: "c", type: "mock", cardWidth: 0 },
        { id: "d", type: "mock", cardWidth: null },
      ];
      localStorage.setItem("katulong-carousel", JSON.stringify({
        cards: invalidCases,
        focused: "a",
      }));

      carousel.activate(makeTiles("a", "b", "c", "d"), "a");

      // After activate() runs, save() serializes current state. None of
      // the invalid widths should have been accepted, so no tile should
      // have a cardWidth in the new saved state.
      const saved = JSON.parse(localStorage.getItem("katulong-carousel"));
      for (const c of saved.cards) {
        assert.strictEqual(c.cardWidth, undefined,
          `tampered cardWidth for ${c.id} should not be restored`);
      }
    });
  });
});
