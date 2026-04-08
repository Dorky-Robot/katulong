/**
 * Tests for window-tab-set.js — per-window tab ordering
 *
 * Verifies:
 * - addTab() without position appends to end
 * - addTab(name, position) inserts at the given index
 * - New tabs appear right of the active tab (Chrome-style)
 * - renameTab() preserves tab position
 * - Duplicate addTab() is a no-op
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Browser API mocks ---
// window-tab-set.js uses sessionStorage, localStorage, and BroadcastChannel.

const stores = { session: {}, local: {} };

globalThis.sessionStorage = {
  getItem: (k) => stores.session[k] ?? null,
  setItem: (k, v) => { stores.session[k] = v; },
  removeItem: (k) => { delete stores.session[k]; },
};

globalThis.localStorage = {
  getItem: (k) => stores.local[k] ?? null,
  setItem: (k, v) => { stores.local[k] = v; },
  removeItem: (k) => { delete stores.local[k]; },
};

// BroadcastChannel stub — postMessage is a no-op
globalThis.BroadcastChannel = class {
  onmessage = null;
  postMessage() {}
  close() {}
};

// Dynamic import after mocks are in place
const { createWindowTabSet } = await import("../public/lib/window-tab-set.js");

function makeTabSet(initialTabs = []) {
  // Seed sessionStorage so loadTabs() picks them up
  stores.session = {};
  stores.local = {};
  if (initialTabs.length > 0) {
    stores.session["katulong-window-tabs"] = JSON.stringify(initialTabs);
  }
  return createWindowTabSet({ getCurrentSession: () => initialTabs[0] || null });
}

describe("WindowTabSet.addTab", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("appends to end when no position given", () => {
    const ts = makeTabSet(["a", "b"]);
    ts.addTab("c");
    assert.deepEqual(ts.getTabs(), ["a", "b", "c"]);
  });

  it("inserts at position 0 (beginning)", () => {
    const ts = makeTabSet(["a", "b"]);
    ts.addTab("c", 0);
    assert.deepEqual(ts.getTabs(), ["c", "a", "b"]);
  });

  it("inserts at position 1 (middle)", () => {
    const ts = makeTabSet(["a", "b", "c"]);
    ts.addTab("x", 1);
    assert.deepEqual(ts.getTabs(), ["a", "x", "b", "c"]);
  });

  it("inserts right of active tab (Chrome-style)", () => {
    const ts = makeTabSet(["a", "b", "c"]);
    // Simulate active tab = "b" (index 1), new tab should go at index 2
    const tabs = ts.getTabs();
    const activeIdx = tabs.indexOf("b");
    ts.addTab("new", activeIdx + 1);
    assert.deepEqual(ts.getTabs(), ["a", "b", "new", "c"]);
  });

  it("appends when position equals tab count", () => {
    const ts = makeTabSet(["a", "b"]);
    ts.addTab("c", 2);
    assert.deepEqual(ts.getTabs(), ["a", "b", "c"]);
  });

  it("is a no-op for duplicate tabs", () => {
    const ts = makeTabSet(["a", "b"]);
    ts.addTab("a", 0);
    assert.deepEqual(ts.getTabs(), ["a", "b"]);
  });

  it("notifies subscribers on add", () => {
    const ts = makeTabSet(["a"]);
    let notified = false;
    ts.subscribe(() => { notified = true; });
    ts.addTab("b");
    assert.ok(notified);
  });

  it("does not notify on duplicate add", () => {
    const ts = makeTabSet(["a"]);
    let notified = false;
    ts.subscribe(() => { notified = true; });
    ts.addTab("a");
    assert.ok(!notified);
  });

  it("grants grace to a tab seeded by loadTabs (URL-boot path)", () => {
    // Regression: when loadTabs() seeds the URL session into `tabs` via
    // getCurrentSession, app.js then calls addTab(name) to grant the
    // reconciler grace period. The original addTab() early-returned for
    // already-present tabs and never set recentlyAdded — so the reconciler
    // pruned the freshly-booted explicit `?s=` session, breaking the
    // smoke E2E tests and any URL bookmark boot.
    stores.session = {};
    stores.local = {};
    const ts = createWindowTabSet({ getCurrentSession: () => "boot-session" });
    // Tab already present from loadTabs() seed
    assert.deepEqual(ts.getTabs(), ["boot-session"]);
    // No grace yet — only loadTabs ran, addTab hasn't been called
    assert.equal(ts.isRecentlyAdded("boot-session"), false);
    // App calls addTab to grant grace
    ts.addTab("boot-session");
    assert.equal(ts.isRecentlyAdded("boot-session"), true);
  });
});

describe("WindowTabSet persistence cap", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("caps saved tabs at 50, dropping oldest", () => {
    // Regression: without a cap, a drift bug or phantom leak can push
    // the persisted tab list into the dozens. On the next boot those
    // phantoms drive a subscribe retry storm via syncCarouselSubscriptions,
    // and the status poller (5s per tile) multiplies the damage. Cap
    // must match MAX_PERSISTED_CARDS in card-carousel.js.
    const seeded = Array.from({ length: 60 }, (_, i) => `tab${i}`);
    stores.session["katulong-window-tabs"] = JSON.stringify(seeded);
    const origWarn = console.warn;
    console.warn = () => {};
    let ts;
    try {
      ts = createWindowTabSet({ getCurrentSession: () => "tab0" });
    } finally {
      console.warn = origWarn;
    }
    const tabs = ts.getTabs();
    assert.equal(tabs.length, 50);
    // Tail preserved (most-recently-added at end of array).
    assert.equal(tabs[tabs.length - 1], "tab59");
    // Oldest dropped.
    assert.ok(!tabs.includes("tab0"));
    assert.ok(!tabs.includes("tab9"));
  });

  it("caps tab count when addTab pushes past the limit", () => {
    stores.session = {};
    stores.local = {};
    const seeded = Array.from({ length: 50 }, (_, i) => `tab${i}`);
    stores.session["katulong-window-tabs"] = JSON.stringify(seeded);
    const ts = createWindowTabSet({ getCurrentSession: () => "tab0" });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      ts.addTab("overflow");
    } finally {
      console.warn = origWarn;
    }
    const tabs = ts.getTabs();
    assert.equal(tabs.length, 50);
    assert.equal(tabs[tabs.length - 1], "overflow");
    assert.ok(!tabs.includes("tab0"), "oldest should be dropped to make room");
  });

  it("persists the capped list to storage (not the full bloated list)", () => {
    const seeded = Array.from({ length: 80 }, (_, i) => `tab${i}`);
    stores.session["katulong-window-tabs"] = JSON.stringify(seeded);
    const origWarn = console.warn;
    console.warn = () => {};
    let ts;
    try {
      ts = createWindowTabSet({ getCurrentSession: () => "tab0" });
      // Trigger a save path explicitly — addTab re-persists.
      ts.addTab("new");
    } finally {
      console.warn = origWarn;
    }
    const persistedSession = JSON.parse(stores.session["katulong-window-tabs"]);
    assert.equal(persistedSession.length, 50);
    const persistedLocal = JSON.parse(stores.local["katulong-last-tabs"]);
    assert.equal(persistedLocal.length, 50);
    // Sanity: the freshly added tab made it through the cap.
    assert.ok(persistedSession.includes("new"));
  });
});

describe("WindowTabSet.renameTab", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("renames tab in-place preserving position", () => {
    const ts = makeTabSet(["a", "b", "c"]);
    ts.renameTab("b", "B");
    assert.deepEqual(ts.getTabs(), ["a", "B", "c"]);
  });

  it("is a no-op when old name not found", () => {
    const ts = makeTabSet(["a", "b"]);
    ts.renameTab("x", "y");
    assert.deepEqual(ts.getTabs(), ["a", "b"]);
  });

  it("notifies subscribers on rename", () => {
    const ts = makeTabSet(["a", "b"]);
    let notified = false;
    ts.subscribe(() => { notified = true; });
    ts.renameTab("a", "A");
    assert.ok(notified);
  });

  it("persists renamed tab to sessionStorage", () => {
    const ts = makeTabSet(["a", "b"]);
    ts.renameTab("a", "A");
    const saved = JSON.parse(stores.session["katulong-window-tabs"]);
    assert.deepEqual(saved, ["A", "b"]);
  });
});
