/**
 * cluster-strips — L2 overview projection.
 *
 * Verifies the projection contract: cluster-strips reads uiStore state,
 * toggles visibility on level, renders one strip per cluster with its
 * tiles, and dispatches switchCluster/focusTile/setLevel/addCluster on
 * clicks. No DOM library — a minimal synthetic document is injected.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

// ── Minimal synthetic DOM ────────────────────────────────────────────
function createEl(tag) {
  const attrs = {};
  const children = [];
  const listeners = {};
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
    hidden: false,
    _id: "",
    _className: "",
    _textContent: "",
    set id(v) { this._id = v; },
    get id() { return this._id; },
    set className(v) { this._className = v; },
    get className() { return this._className; },
    set textContent(v) {
      this._textContent = v;
      if (v === "") children.length = 0;
    },
    get textContent() { return this._textContent; },
    get children() { return children; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(child) {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    remove() {
      if (el.parentElement) {
        const i = el.parentElement.children.indexOf(el);
        if (i >= 0) el.parentElement.children.splice(i, 1);
      }
      el.parentElement = null;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    _listeners: listeners,
    removeEventListener() {},
    dispatchEvent(type, target) {
      const realTarget = target || el;
      const ev = {
        type,
        target: realTarget,
      };
      // Bubble up from the dispatching element; each listener receives the
      // same event with `target` fixed at the originating node (matches
      // browser semantics closely enough for these tests).
      let cur = el;
      while (cur) {
        const fns = cur._listeners?.[type];
        if (fns) fns.forEach(fn => fn(ev));
        cur = cur.parentElement;
      }
    },
    parentElement: null,
    closest(sel) { return closest(el, sel); },
  };
  return el;
}

function closest(el, sel) {
  let cur = el;
  while (cur) {
    if (matches(cur, sel)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function matches(el, sel) {
  // supports [attr] only (that's all cluster-strips uses)
  const m = sel.match(/^\[([a-z-]+)\]$/);
  if (!m) return false;
  return el.getAttribute(m[1]) !== null;
}

function findByAttr(root, name, value) {
  if (root.getAttribute?.(name) === value) return root;
  for (const c of root.children || []) {
    const f = findByAttr(c, name, value);
    if (f) return f;
  }
  return null;
}

function allByAttr(root, name) {
  const out = [];
  const walk = (el) => {
    if (el.getAttribute?.(name) !== null && el.getAttribute(name) !== undefined) out.push(el);
    (el.children || []).forEach(walk);
  };
  walk(root);
  return out.filter(e => e.getAttribute(name) !== null);
}

function installDocument() {
  const docEl = createEl("html");
  globalThis.document = {
    documentElement: docEl,
    createElement: (tag) => createEl(tag),
  };
}

const { createUiStore } = await import(
  new URL("../public/lib/ui-store.js", import.meta.url).href
);
const { createClusterStrips } = await import(
  new URL("../public/lib/cluster-strips.js", import.meta.url).href
);

function seed(store, clusters) {
  for (let c = 0; c < clusters.length; c++) {
    if (c > 0) store.addCluster({ switchTo: true });
    else store.switchCluster(0);
    for (const tile of clusters[c]) {
      store.addTile({ id: tile.id, type: tile.type || "terminal", props: tile.props || {} });
    }
  }
  store.switchCluster(0);
}

describe("cluster-strips — visibility & projection", () => {
  let mountIn, store, handle;

  beforeEach(() => {
    installDocument();
    mountIn = document.createElement("div");
    store = createUiStore();
    handle = createClusterStrips({ store, mountIn });
  });

  it("root mounts hidden at level 1", () => {
    assert.strictEqual(handle.element.hidden, true);
    assert.strictEqual(document.documentElement.getAttribute("data-ui-level"), "1");
  });

  it("shows overlay when level flips to 2", () => {
    store.setLevel(2);
    assert.strictEqual(handle.element.hidden, false);
    assert.strictEqual(document.documentElement.getAttribute("data-ui-level"), "2");
  });

  it("hides again when level returns to 1", () => {
    store.setLevel(2);
    store.setLevel(1);
    assert.strictEqual(handle.element.hidden, true);
  });

  it("renders one strip per cluster", () => {
    seed(store, [[{ id: "a" }], [{ id: "b" }], [{ id: "c" }]]);
    store.setLevel(2);
    const strips = allByAttr(handle.element, "data-cluster-idx");
    assert.strictEqual(strips.length, 3);
  });

  it("marks the active cluster with data-active", () => {
    seed(store, [[{ id: "a" }], [{ id: "b" }]]);
    store.switchCluster(1);
    store.setLevel(2);
    const strips = allByAttr(handle.element, "data-cluster-idx");
    assert.strictEqual(strips[0].getAttribute("data-active"), null);
    assert.strictEqual(strips[1].getAttribute("data-active"), "true");
  });

  it("renders tile cards with labels from getTileLabel", () => {
    seed(store, [[{ id: "t1", props: { sessionName: "foo" } }]]);
    store.setLevel(2);
    handle.destroy();
    // Re-mount with custom label function
    const h2 = createClusterStrips({
      store,
      mountIn: document.createElement("div"),
      getTileLabel: (tile) => `LBL:${tile.id}`,
    });
    store.setLevel(1);
    store.setLevel(2);
    const card = findByAttr(h2.element, "data-tile-id", "t1");
    assert.ok(card);
    assert.strictEqual(card.textContent, "LBL:t1");
  });
});

describe("cluster-strips — click routing", () => {
  let mountIn, store;

  beforeEach(() => {
    installDocument();
    mountIn = document.createElement("div");
    store = createUiStore();
    createClusterStrips({ store, mountIn });
  });

  it("tapping a strip switches cluster and returns to L1", () => {
    seed(store, [[{ id: "a" }], [{ id: "b" }]]);
    store.setLevel(2);
    const strip = findByAttr(document.documentElement.parentElement || mountIn, "data-cluster-idx", "1")
      || allByAttr(mountIn, "data-cluster-idx")[1];
    strip.dispatchEvent("click", strip);
    assert.strictEqual(store.getState().activeClusterIdx, 1);
    assert.strictEqual(store.getState().level, 1);
  });

  it("tapping a card also focuses that tile", () => {
    seed(store, [[{ id: "a" }], [{ id: "target" }]]);
    store.setLevel(2);
    const card = findByAttr(mountIn, "data-tile-id", "target");
    assert.ok(card);
    card.dispatchEvent("click", card);
    assert.strictEqual(store.getState().activeClusterIdx, 1);
    assert.strictEqual(store.getState().focusedTileIdByCluster[1], "target");
    assert.strictEqual(store.getState().level, 1);
  });

  it("+ button adds a new cluster and stays at level 2", () => {
    seed(store, [[{ id: "a" }]]);
    store.setLevel(2);
    const before = store.getState().clusters.length;
    const addBtn = allByAttr(mountIn, "aria-label").find(e => e.getAttribute("aria-label") === "Add new cluster");
    assert.ok(addBtn);
    addBtn.dispatchEvent("click", addBtn);
    assert.strictEqual(store.getState().clusters.length, before + 1);
    assert.strictEqual(store.getState().level, 2);
    assert.strictEqual(store.getState().activeClusterIdx, 0);
  });
});

describe("cluster-strips — destroy cleanup", () => {
  it("unsubscribes and removes DOM on destroy", () => {
    installDocument();
    const mountIn = document.createElement("div");
    const store = createUiStore();
    const handle = createClusterStrips({ store, mountIn });
    handle.destroy();
    assert.strictEqual(handle.element.parentElement, null);
    assert.strictEqual(document.documentElement.getAttribute("data-ui-level"), null);
    // Subsequent store changes should not throw or re-render.
    store.setLevel(2);
    assert.strictEqual(handle.element.hidden, true);
  });
});
