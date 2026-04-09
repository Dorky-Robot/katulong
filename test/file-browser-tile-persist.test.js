/**
 * file-browser tile: persistence opt-out + close path integration
 *
 * These tests pin two regressions the carousel used to have:
 *
 *  1. File-browser tiles (which have no tmux-backed state) must not be
 *     written to the carousel's localStorage persistence — they are
 *     session-scoped. Reload should forget them.
 *
 *  2. The `ctx.requestClose()` wiring landed in a4d8048 must actually
 *     result in the tile being removed from the carousel when called
 *     from any code path (X button, tab-bar context menu, etc.).
 *
 * Both are asserted here at the carousel seam so the capability check
 * is exercised end-to-end with the real card-carousel module (not the
 * file-browser tile in isolation, which was already tested).
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// ── Minimal DOM shims (mirror card-carousel.test.js) ───────────────────

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
    querySelector: () => null,
    querySelectorAll: () => [],
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
    get offsetWidth() { return 800; },
    _classes: classes,
    _styles: styles,
    _children: children,
    _listeners: listeners,
  };
  return el;
}

function setupGlobals() {
  Object.defineProperty(globalThis, "navigator", {
    value: { maxTouchPoints: 0, userAgent: "" },
    writable: true, configurable: true,
  });
  globalThis.window = globalThis.window || globalThis;
  globalThis.window.innerWidth = 1024;
  if (!globalThis.window.addEventListener) globalThis.window.addEventListener = () => {};
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  globalThis.screen = { orientation: { type: "landscape-primary", addEventListener: () => {} }, width: 1024, height: 768 };
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = (tag) => createMockElement(tag);
  globalThis.document.getElementById = () => null;
  globalThis.document.querySelector = () => null;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  const storage = {};
  globalThis.__storage = storage;
  globalThis.localStorage = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
}

function makeMockTile(type, id) {
  return {
    type,
    get sessionName() { return id; },
    mount: mock.fn(),
    unmount: mock.fn(),
    focus: mock.fn(),
    blur: mock.fn(),
    resize: mock.fn(),
    getTitle: () => id,
    getIcon: () => "x",
    serialize: () => ({ type, sessionName: id }),
  };
}

function makePersistableFalseTile(type, id) {
  const t = makeMockTile(type, id);
  t.persistable = false;
  return t;
}

async function importCarousel() {
  const url = new URL("../public/lib/card-carousel.js", import.meta.url);
  const mod = await import(url.href + "?t=" + Date.now() + Math.random());
  return mod;
}

describe("file-browser tile — persistence opt-out", () => {
  let createCardCarousel;
  let onCardDismissed;
  let container;
  let carousel;

  beforeEach(async () => {
    setupGlobals();
    ({ createCardCarousel } = await importCarousel());
    container = createMockElement("div");
    onCardDismissed = mock.fn();
    carousel = createCardCarousel({
      container,
      onCardDismissed,
      onAllCardsDismissed: mock.fn(),
      isTypePersistable: (type) => type !== "file-browser",
    });
  });

  it("save() skips tiles with persistable: false", () => {
    const term = makeMockTile("terminal", "t1");
    const fb = makePersistableFalseTile("file-browser", "file-browser-abc");
    carousel.activate([{ id: "t1", tile: term }, { id: "file-browser-abc", tile: fb }], "t1");
    const raw = globalThis.localStorage.getItem("katulong-carousel");
    assert.ok(raw, "carousel persisted something");
    const parsed = JSON.parse(raw);
    const ids = parsed.cards.map(c => c.id);
    assert.deepStrictEqual(ids, ["t1"], "file-browser tile should not be persisted");
  });

  it("save() omits persistence entirely if all tiles are non-persistable", () => {
    const fb = makePersistableFalseTile("file-browser", "file-browser-abc");
    carousel.activate([{ id: "file-browser-abc", tile: fb }], "file-browser-abc");
    const raw = globalThis.localStorage.getItem("katulong-carousel");
    // Either absent or an empty cards array — both mean "nothing to restore"
    if (raw) {
      const parsed = JSON.parse(raw);
      assert.deepStrictEqual(parsed.cards, []);
    }
  });

  it("restore() drops legacy persisted file-browser entries (storage migration)", () => {
    // Simulate a user whose localStorage was written by the buggy version
    globalThis.localStorage.setItem("katulong-carousel", JSON.stringify({
      cards: [
        { id: "t1", type: "terminal", sessionName: "t1" },
        { id: "file-browser-legacy", type: "file-browser", cwd: "/tmp" },
      ],
      focused: "file-browser-legacy",
    }));
    const state = carousel.restore();
    assert.ok(state, "restore returns state");
    const ids = state.tiles.map(t => t.id);
    assert.deepStrictEqual(ids, ["t1"], "legacy file-browser entry dropped on restore");
  });
});

describe("file-browser tile — ctx.requestClose removes the card", () => {
  let createCardCarousel;
  let onCardDismissed;
  let carousel;

  beforeEach(async () => {
    setupGlobals();
    ({ createCardCarousel } = await importCarousel());
    onCardDismissed = mock.fn();
    carousel = createCardCarousel({
      container: createMockElement("div"),
      onCardDismissed,
      onAllCardsDismissed: mock.fn(),
      isTypePersistable: (type) => type !== "file-browser",
    });
  });

  it("ctx.requestClose() removes the card and fires onCardDismissed", async () => {
    let capturedCtx = null;
    const fb = makePersistableFalseTile("file-browser", "file-browser-abc");
    fb.mount = mock.fn((_el, ctx) => { capturedCtx = ctx; });
    const term = makeMockTile("terminal", "t1");
    carousel.activate(
      [{ id: "t1", tile: term }, { id: "file-browser-abc", tile: fb }],
      "file-browser-abc",
    );
    assert.ok(capturedCtx, "mount was called with a ctx");
    assert.strictEqual(typeof capturedCtx.requestClose, "function");
    capturedCtx.requestClose();
    // requestClose defers via queueMicrotask — flush it
    await new Promise(r => queueMicrotask(r));
    assert.deepStrictEqual(carousel.getCards(), ["t1"]);
    assert.strictEqual(fb.unmount.mock.callCount(), 1);
    assert.strictEqual(onCardDismissed.mock.callCount(), 1);
    assert.strictEqual(onCardDismissed.mock.calls[0].arguments[0], "file-browser-abc");
  });
});
