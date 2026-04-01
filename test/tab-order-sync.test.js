/**
 * Tests for tab order sync — carousel as source of truth
 *
 * Verifies:
 * - navigateTab logic uses carousel order when carousel is active
 * - Tab bar session list uses carousel order when carousel is active
 * - windowTabSet syncs to carousel order after restore
 * - Drag reorder through windowTabSet syncs carousel via subscriber
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Browser API mocks ---
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

globalThis.BroadcastChannel = class {
  onmessage = null;
  postMessage() {}
  close() {}
};

const { createWindowTabSet } = await import("../public/lib/window-tab-set.js");

function makeTabSet(initialTabs = []) {
  stores.session = {};
  stores.local = {};
  if (initialTabs.length > 0) {
    stores.session["katulong-window-tabs"] = JSON.stringify(initialTabs);
  }
  return createWindowTabSet({ getCurrentSession: () => initialTabs[0] || null });
}

/** Simulate carousel.getCards() — returns a fixed ordered array */
function mockCarousel(cards, active = true) {
  return {
    isActive: () => active,
    getCards: () => [...cards],
  };
}

/**
 * Extracted navigateTab logic — mirrors app.js implementation.
 * Uses carousel order when active, falls back to windowTabSet.
 */
function navigateTab(direction, carousel, windowTabSet, currentSession) {
  const tabs = carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs();
  if (tabs.length <= 1) return null;
  const idx = tabs.indexOf(currentSession);
  if (idx === -1) return null;
  return tabs[(idx + direction + tabs.length) % tabs.length];
}

/**
 * Extracted getSessionList logic — mirrors shortcut-bar.js implementation.
 * Uses carousel order when active, falls back to windowTabSet.
 */
function getSessionList(carousel, windowTabSet, allSessions) {
  const tabNames = carousel?.isActive() ? carousel.getCards() : windowTabSet.getTabs();
  const sessionMap = new Map(allSessions.map(s => [s.name, s]));
  return tabNames.map(n => sessionMap.get(n) || { name: n }).filter(Boolean);
}

describe("navigateTab with carousel as source of truth", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("uses carousel order when carousel is active", () => {
    const carousel = mockCarousel(["c", "a", "b"]);
    const ts = makeTabSet(["a", "b", "c"]);

    // From "a", next (+1) should go to "b" in carousel order [c, a, b]
    const next = navigateTab(+1, carousel, ts, "a");
    assert.equal(next, "b");
  });

  it("uses carousel order for previous tab", () => {
    const carousel = mockCarousel(["c", "a", "b"]);
    const ts = makeTabSet(["a", "b", "c"]);

    // From "a", prev (-1) should go to "c" in carousel order [c, a, b]
    const prev = navigateTab(-1, carousel, ts, "a");
    assert.equal(prev, "c");
  });

  it("wraps around at end of carousel", () => {
    const carousel = mockCarousel(["c", "a", "b"]);
    const ts = makeTabSet(["a", "b", "c"]);

    // From "b" (last in carousel), next (+1) should wrap to "c"
    const next = navigateTab(+1, carousel, ts, "b");
    assert.equal(next, "c");
  });

  it("falls back to windowTabSet when carousel is inactive", () => {
    const carousel = mockCarousel(["c", "a", "b"], false);
    const ts = makeTabSet(["a", "b", "c"]);

    // From "a", next (+1) should go to "b" in tab set order [a, b, c]
    const next = navigateTab(+1, carousel, ts, "a");
    assert.equal(next, "b");
  });

  it("returns null when current session is not in list", () => {
    const carousel = mockCarousel(["a", "b"]);
    const ts = makeTabSet(["a", "b"]);

    const next = navigateTab(+1, carousel, ts, "unknown");
    assert.equal(next, null);
  });

  it("returns null when only one tab", () => {
    const carousel = mockCarousel(["a"]);
    const ts = makeTabSet(["a"]);

    const next = navigateTab(+1, carousel, ts, "a");
    assert.equal(next, null);
  });
});

describe("getSessionList with carousel as source of truth", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("returns sessions in carousel order when active", () => {
    const carousel = mockCarousel(["c", "a", "b"]);
    const ts = makeTabSet(["a", "b", "c"]);
    const sessions = [{ name: "a" }, { name: "b" }, { name: "c" }];

    const result = getSessionList(carousel, ts, sessions);
    assert.deepEqual(result.map(s => s.name), ["c", "a", "b"]);
  });

  it("returns sessions in windowTabSet order when carousel is inactive", () => {
    const carousel = mockCarousel(["c", "a", "b"], false);
    const ts = makeTabSet(["a", "b", "c"]);
    const sessions = [{ name: "a" }, { name: "b" }, { name: "c" }];

    const result = getSessionList(carousel, ts, sessions);
    assert.deepEqual(result.map(s => s.name), ["a", "b", "c"]);
  });

  it("preserves session metadata from store", () => {
    const carousel = mockCarousel(["b", "a"]);
    const ts = makeTabSet(["a", "b"]);
    const sessions = [
      { name: "a", attached: true },
      { name: "b", attached: false },
    ];

    const result = getSessionList(carousel, ts, sessions);
    assert.equal(result[0].name, "b");
    assert.equal(result[0].attached, false);
    assert.equal(result[1].name, "a");
    assert.equal(result[1].attached, true);
  });
});

describe("windowTabSet syncs to carousel order after restore", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("reorderTabs aligns windowTabSet with carousel order", () => {
    const ts = makeTabSet(["a", "b", "c"]);
    assert.deepEqual(ts.getTabs(), ["a", "b", "c"]);

    // Simulate carousel restoring with different order
    const carouselOrder = ["c", "a", "b"];
    ts.reorderTabs(carouselOrder);

    assert.deepEqual(ts.getTabs(), ["c", "a", "b"]);
  });

  it("reorderTabs drops tabs not in windowTabSet", () => {
    const ts = makeTabSet(["a", "b"]);

    // Carousel has an extra card that windowTabSet doesn't know about
    ts.reorderTabs(["b", "unknown", "a"]);

    // "unknown" is filtered out (not in ts.tabs)
    assert.deepEqual(ts.getTabs(), ["b", "a"]);
  });

  it("notifies subscribers after sync", () => {
    const ts = makeTabSet(["a", "b", "c"]);
    let notified = false;
    ts.subscribe(() => { notified = true; });

    ts.reorderTabs(["c", "b", "a"]);
    assert.ok(notified);
  });
});

describe("drag reorder syncs carousel via windowTabSet subscriber", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("windowTabSet subscriber can trigger carousel reorder", () => {
    const ts = makeTabSet(["a", "b", "c"]);
    let carouselCards = ["a", "b", "c"];

    // Simulate the app.js subscriber that syncs carousel from windowTabSet
    ts.subscribe(() => {
      const newOrder = ts.getTabs().filter(id => carouselCards.includes(id));
      for (const id of carouselCards) {
        if (!newOrder.includes(id)) newOrder.push(id);
      }
      carouselCards = newOrder;
    });

    // Simulate drag reorder: move "c" to position 0
    ts.reorderTabs(["c", "a", "b"]);

    // Both should now agree
    assert.deepEqual(ts.getTabs(), ["c", "a", "b"]);
    assert.deepEqual(carouselCards, ["c", "a", "b"]);
  });
});
