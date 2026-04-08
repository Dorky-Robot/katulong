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

// BroadcastChannel stub — postMessage is a no-op.
// Track constructed instances so tests can simulate a remote message by
// calling `channel.onmessage({ data: ... })` on the most recent instance.
const broadcastChannels = [];
globalThis.BroadcastChannel = class {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    broadcastChannels.push(this);
  }
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

  it("keeps newly-added tab in memory even when storage must trim", () => {
    // Regression: an earlier draft reassigned the closure `tabs` inside
    // saveTabs() when trimming to the cap. addTab("overflow") at a full
    // set would then splice "overflow" onto the end, saveTabs() would
    // tail-slice (dropping the oldest), and the in-memory `tabs` would
    // silently shrink — which was fine for append but catastrophic for
    // head-insert (see the next test). The fix: the live array stays
    // canonical; only the persisted view is trimmed.
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
    // In-memory: 51 tabs — nothing has been dropped from the live array.
    const tabs = ts.getTabs();
    assert.equal(tabs.length, 51);
    assert.equal(tabs[tabs.length - 1], "overflow");
    assert.ok(tabs.includes("tab0"), "in-memory tabs must not be mutated by saveTabs");
    // Storage: trimmed to cap — the oldest is dropped from the persisted view.
    const persisted = JSON.parse(stores.session["katulong-window-tabs"]);
    assert.equal(persisted.length, 50);
    assert.ok(persisted.includes("overflow"));
    assert.ok(!persisted.includes("tab0"), "oldest dropped from storage only");
  });

  it("head-insert of a new tab on a full set keeps the new tab", () => {
    // Regression: before the saveTabs() side-effect fix, addTab("new", 0)
    // on a full set spliced "new" at index 0, then in-place tail-slice
    // dropped exactly that entry ("new") from both storage AND the live
    // `tabs` array. The carousel kept its tile for the new session, the
    // tab bar lost the button, and the two layers diverged. The fix is
    // to leave `tabs` unmutated so the new head entry survives.
    stores.session = {};
    stores.local = {};
    const seeded = Array.from({ length: 50 }, (_, i) => `tab${i}`);
    stores.session["katulong-window-tabs"] = JSON.stringify(seeded);
    const ts = createWindowTabSet({ getCurrentSession: () => "tab0" });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      ts.addTab("new", 0);
    } finally {
      console.warn = origWarn;
    }
    const tabs = ts.getTabs();
    assert.equal(tabs[0], "new", "new tab survives at the head position");
    assert.equal(tabs.length, 51, "live tabs retains the full set");
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

describe("WindowTabSet.onRemoteKill", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
    broadcastChannels.length = 0;
  });

  it("invokes onRemoteKill when a session-killed message arrives for a local tab", () => {
    // Regression: previously the BroadcastChannel handler only mutated the
    // local tab list and relied on the subscribe() bridge to reorder the
    // carousel. But carousel.reorderCards re-appends missing ids instead of
    // removing them, so the killed card lingered as a zombie until the
    // /sessions reconciler caught up several seconds later. The fix is a
    // targeted `onRemoteKill` callback that tears down carousel/pool/WS.
    const killed = [];
    stores.session["katulong-window-tabs"] = JSON.stringify(["a", "b"]);
    const ts = createWindowTabSet({
      getCurrentSession: () => "a",
      onRemoteKill: (name) => killed.push(name),
    });
    const channel = broadcastChannels[broadcastChannels.length - 1];
    channel.onmessage({ data: { type: "session-killed", sessionName: "b" } });
    assert.deepEqual(killed, ["b"]);
    // Tab removed from local state before the callback fires, so host
    // teardown sees the authoritative post-kill view.
    assert.deepEqual(ts.getTabs(), ["a"]);
  });

  it("does not invoke onRemoteKill when the killed session is not a local tab", () => {
    // Cross-window broadcasts reach every window, but only windows that
    // had the session open need to tear anything down.
    const killed = [];
    stores.session["katulong-window-tabs"] = JSON.stringify(["a"]);
    createWindowTabSet({
      getCurrentSession: () => "a",
      onRemoteKill: (name) => killed.push(name),
    });
    const channel = broadcastChannels[broadcastChannels.length - 1];
    channel.onmessage({ data: { type: "session-killed", sessionName: "other" } });
    assert.deepEqual(killed, []);
  });

  it("clears the grace period for the killed session", () => {
    // A freshly-added local tab that another window kills must not keep
    // its grace entry alive — the reconciler would then refuse to prune
    // it if it somehow reappeared in the local array.
    stores.session["katulong-window-tabs"] = JSON.stringify(["a", "b"]);
    const ts = createWindowTabSet({
      getCurrentSession: () => "a",
      onRemoteKill: () => {},
    });
    ts.addTab("b"); // grant grace (idempotent — re-stamps)
    assert.equal(ts.isRecentlyAdded("b"), true);
    const channel = broadcastChannels[broadcastChannels.length - 1];
    channel.onmessage({ data: { type: "session-killed", sessionName: "b" } });
    assert.equal(ts.isRecentlyAdded("b"), false);
  });

  it("tolerates missing onRemoteKill callback (backwards compatible)", () => {
    stores.session["katulong-window-tabs"] = JSON.stringify(["a", "b"]);
    const ts = createWindowTabSet({ getCurrentSession: () => "a" });
    const channel = broadcastChannels[broadcastChannels.length - 1];
    // Should not throw when onRemoteKill is undefined.
    channel.onmessage({ data: { type: "session-killed", sessionName: "b" } });
    assert.deepEqual(ts.getTabs(), ["a"]);
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
