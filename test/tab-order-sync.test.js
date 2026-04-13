/**
 * Tests for tab order sync — ui-store as source of truth
 *
 * Verifies:
 * - navigateTab uses uiStore order and focusedId (pure function)
 * - navigateTab works for non-terminal tiles (feed, file-browser)
 * - moveTab reorders tiles in ui-store order
 * - jumpToTab jumps to specific positions
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
const { navigateTab, moveTab, jumpToTab } = await import("../public/lib/navigation.js");

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

/** Build a minimal uiState for navigation tests */
function mockUiState(order, focusedId) {
  const tiles = {};
  for (const id of order) {
    tiles[id] = { id, type: "terminal", props: {} };
  }
  return { order, focusedId, tiles };
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

describe("navigateTab — pure function using uiStore state", () => {
  beforeEach(() => {
    stores.session = {};
    stores.local = {};
  });

  it("navigates to next tile by focusedId", () => {
    const state = mockUiState(["c", "a", "b"], "a");
    const action = navigateTab(state, +1);
    assert.equal(action.id, "b");
  });

  it("navigates to previous tile by focusedId", () => {
    const state = mockUiState(["c", "a", "b"], "a");
    const action = navigateTab(state, -1);
    assert.equal(action.id, "c");
  });

  it("wraps around at end of order", () => {
    const state = mockUiState(["c", "a", "b"], "b");
    const action = navigateTab(state, +1);
    assert.equal(action.id, "c");
  });

  it("wraps around at start of order", () => {
    const state = mockUiState(["c", "a", "b"], "c");
    const action = navigateTab(state, -1);
    assert.equal(action.id, "b");
  });

  it("returns null when focusedId is not in order", () => {
    const state = mockUiState(["a", "b"], "unknown");
    const action = navigateTab(state, +1);
    assert.equal(action, null);
  });

  it("returns null when only one tile", () => {
    const state = mockUiState(["a"], "a");
    const action = navigateTab(state, +1);
    assert.equal(action, null);
  });

  it("works with non-terminal tile IDs (feed, file-browser)", () => {
    // This is the key bug fix — tile IDs like "feed-abc123" are used
    // as focusedId, not session names. Old code would fail here because
    // state.session.name would hold a terminal session name, not the
    // feed tile's ID.
    const state = mockUiState(["session-1", "feed-abc123", "session-2"], "feed-abc123");
    const action = navigateTab(state, +1);
    assert.equal(action.id, "session-2");
  });

  it("navigates backward from non-terminal tile", () => {
    const state = mockUiState(["session-1", "feed-abc123", "session-2"], "feed-abc123");
    const action = navigateTab(state, -1);
    assert.equal(action.id, "session-1");
  });

  it("wraps from non-terminal tile at end", () => {
    const state = mockUiState(["session-1", "feed-abc123"], "feed-abc123");
    const action = navigateTab(state, +1);
    assert.equal(action.id, "session-1");
  });
});

describe("moveTab — pure function using uiStore state", () => {
  it("swaps focused tile with its right neighbor", () => {
    const state = mockUiState(["a", "b", "c"], "b");
    const action = moveTab(state, +1);
    assert.deepEqual(action.order, ["a", "c", "b"]);
  });

  it("swaps focused tile with its left neighbor", () => {
    const state = mockUiState(["a", "b", "c"], "b");
    const action = moveTab(state, -1);
    assert.deepEqual(action.order, ["b", "a", "c"]);
  });

  it("returns null at left edge (no wrap)", () => {
    const state = mockUiState(["a", "b", "c"], "a");
    const action = moveTab(state, -1);
    assert.equal(action, null);
  });

  it("returns null at right edge (no wrap)", () => {
    const state = mockUiState(["a", "b", "c"], "c");
    const action = moveTab(state, +1);
    assert.equal(action, null);
  });
});

describe("jumpToTab — pure function using uiStore state", () => {
  it("jumps to position 1 (first tile)", () => {
    const state = mockUiState(["a", "b", "c"], "c");
    const action = jumpToTab(state, 1);
    assert.equal(action.id, "a");
  });

  it("jumps to position 3 (third tile)", () => {
    const state = mockUiState(["a", "b", "c"], "a");
    const action = jumpToTab(state, 3);
    assert.equal(action.id, "c");
  });

  it("returns null when already at target position", () => {
    const state = mockUiState(["a", "b", "c"], "a");
    const action = jumpToTab(state, 1);
    assert.equal(action, null);
  });

  it("returns null for out-of-range position", () => {
    const state = mockUiState(["a", "b"], "a");
    const action = jumpToTab(state, 5);
    assert.equal(action, null);
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

    const carouselOrder = ["c", "a", "b"];
    ts.reorderTabs(carouselOrder);

    assert.deepEqual(ts.getTabs(), ["c", "a", "b"]);
  });

  it("reorderTabs drops tabs not in windowTabSet", () => {
    const ts = makeTabSet(["a", "b"]);

    ts.reorderTabs(["b", "unknown", "a"]);

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

    ts.subscribe(() => {
      const newOrder = ts.getTabs().filter(id => carouselCards.includes(id));
      for (const id of carouselCards) {
        if (!newOrder.includes(id)) newOrder.push(id);
      }
      carouselCards = newOrder;
    });

    ts.reorderTabs(["c", "a", "b"]);

    assert.deepEqual(ts.getTabs(), ["c", "a", "b"]);
    assert.deepEqual(carouselCards, ["c", "a", "b"]);
  });
});
