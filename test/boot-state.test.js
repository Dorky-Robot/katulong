import { describe, it } from "node:test";
import assert from "node:assert";

// Stub localStorage before loading ui-store (which is imported by
// boot-state.js indirectly through normalize's subscribe path).
const _storage = {};
globalThis.localStorage = {
  getItem: (k) => _storage[k] ?? null,
  setItem: (k, v) => { _storage[k] = v; },
  removeItem: (k) => { delete _storage[k]; },
};

const { buildBootState } = await import(
  new URL("../public/lib/boot-state.js", import.meta.url).href
);
const { normalize } = await import(
  new URL("../public/lib/ui-store.js", import.meta.url).href
);

// ── Helpers ────────────────────────────────────────────────────────────
// Build a v3-shape "already persisted" input. boot-state expects persisted
// to be the output of ui-store.loadFromStorage(), which runs `normalize` —
// so derived fields (tiles, order, focusedId) are present. We mimic that.
function persistedV3({ clusters, activeClusterIdx = 0, focusedTileIdByCluster }) {
  return normalize({
    version: 3,
    clusters,
    activeClusterIdx,
    focusedTileIdByCluster,
  });
}

describe("buildBootState — no sources", () => {
  it("returns EMPTY_STATE when nothing is persisted and no URL hint", () => {
    const { state, migratedLegacy } = buildBootState({});
    assert.strictEqual(migratedLegacy, false);
    assert.deepStrictEqual(state.tiles, {});
    assert.strictEqual(state.focusedId, null);
    assert.strictEqual(state.clusters.length, 1);
    assert.deepStrictEqual(state.clusters[0], []);
  });
});

describe("buildBootState — persisted state wins", () => {
  it("uses persisted state when present, ignores legacy", () => {
    const persisted = persistedV3({
      clusters: [[[{ id: "a", type: "terminal", props: {} }]]],
      focusedTileIdByCluster: ["a"],
    });
    const legacyCarousel = {
      tiles: [{ id: "legacy", type: "terminal", sessionName: "legacy" }],
      focused: "legacy",
    };
    const { state, migratedLegacy } = buildBootState({
      persisted,
      legacyCarousel,
      getRenderer: () => ({}),
    });
    assert.strictEqual(migratedLegacy, false);
    assert.ok(state.tiles.a);
    assert.ok(!state.tiles.legacy);
  });

  it("treats persisted state with no tiles as empty and falls back to legacy", () => {
    const persisted = persistedV3({
      clusters: [[]],
      focusedTileIdByCluster: [null],
    });
    const { state, migratedLegacy } = buildBootState({
      persisted,
      legacyCarousel: {
        tiles: [{ id: "s1", type: "terminal", sessionName: "s1" }],
        focused: "s1",
      },
      getRenderer: () => ({ describe: () => ({}) }),
    });
    assert.strictEqual(migratedLegacy, true);
    assert.ok(state.tiles.s1);
  });
});

describe("buildBootState — legacy migration", () => {
  it("migrates legacy carousel state into a single cluster of single-slot columns", () => {
    const { state, migratedLegacy } = buildBootState({
      legacyCarousel: {
        tiles: [
          { id: "s1", type: "terminal", sessionName: "s1" },
          { id: "s2", type: "terminal", sessionName: "s2" },
        ],
        focused: "s2",
      },
      getRenderer: () => ({ describe: () => ({}) }),
    });
    assert.strictEqual(migratedLegacy, true);
    assert.strictEqual(state.clusters.length, 1);
    assert.strictEqual(state.clusters[0].length, 2);
    assert.strictEqual(state.clusters[0][0][0].id, "s1");
    assert.strictEqual(state.clusters[0][1][0].id, "s2");
    assert.strictEqual(state.focusedId, "s2");
    assert.strictEqual(state.focusedTileIdByCluster[0], "s2");
    // Props are stripped of id/type/cardWidth.
    assert.strictEqual(state.tiles.s1.props.sessionName, "s1");
    assert.strictEqual(state.tiles.s1.props.id, undefined);
    assert.strictEqual(state.tiles.s1.props.type, undefined);
  });

  it("maps legacy 'dashboard' type to 'cluster'", () => {
    const { state } = buildBootState({
      legacyCarousel: {
        tiles: [{ id: "d1", type: "dashboard" }],
        focused: "d1",
      },
      getRenderer: (type) => (type === "cluster" ? { describe: () => ({}) } : null),
    });
    assert.strictEqual(state.tiles.d1.type, "cluster");
  });

  it("drops tiles whose type has no renderer", () => {
    const { state } = buildBootState({
      legacyCarousel: {
        tiles: [
          { id: "ok", type: "terminal" },
          { id: "junk", type: "unknown-type" },
        ],
        focused: "ok",
      },
      getRenderer: (type) => (type === "terminal" ? { describe: () => ({}) } : null),
    });
    assert.ok(state.tiles.ok);
    assert.ok(!state.tiles.junk);
  });

  it("does not flag migration when legacy has no tiles", () => {
    const { migratedLegacy } = buildBootState({
      legacyCarousel: { tiles: [], focused: null },
    });
    assert.strictEqual(migratedLegacy, false);
  });

  it("falls back focused to first tile when legacy focus is unknown", () => {
    const { state } = buildBootState({
      legacyCarousel: {
        tiles: [{ id: "s1", type: "terminal", sessionName: "s1" }],
        focused: "ghost",
      },
      getRenderer: () => ({ describe: () => ({}) }),
    });
    assert.strictEqual(state.focusedId, "s1");
  });
});

describe("buildBootState — URL session hint", () => {
  it("adds a new terminal tile and focuses it", () => {
    const { state } = buildBootState({ urlSession: "hello" });
    assert.ok(state.tiles.hello);
    assert.strictEqual(state.tiles.hello.type, "terminal");
    assert.strictEqual(state.tiles.hello.props.sessionName, "hello");
    assert.strictEqual(state.focusedId, "hello");
  });

  it("does not duplicate when the session is already present", () => {
    const persisted = persistedV3({
      clusters: [[[{ id: "existing", type: "terminal", props: { sessionName: "existing" } }]]],
      focusedTileIdByCluster: ["existing"],
    });
    const { state } = buildBootState({ persisted, urlSession: "existing" });
    assert.strictEqual(Object.keys(state.tiles).length, 1);
    assert.strictEqual(state.focusedId, "existing");
  });

  it("preserves persisted focusedId when URL session was already present", () => {
    const persisted = persistedV3({
      clusters: [[
        [{ id: "a", type: "terminal", props: {} }],
        [{ id: "b", type: "terminal", props: {} }],
      ]],
      focusedTileIdByCluster: ["b"],
    });
    // User refreshed with ?s=a but b was focused last. Persisted wins.
    const { state } = buildBootState({ persisted, urlSession: "a" });
    assert.strictEqual(state.focusedId, "b");
  });

  it("appends the URL tile to the active cluster", () => {
    const persisted = persistedV3({
      clusters: [
        [[{ id: "a", type: "terminal", props: {} }]],
        [[{ id: "w1", type: "terminal", props: {} }]],
      ],
      activeClusterIdx: 1,
      focusedTileIdByCluster: ["a", "w1"],
    });
    const { state } = buildBootState({ persisted, urlSession: "new" });
    assert.strictEqual(state.activeClusterIdx, 1);
    assert.strictEqual(state.focusedId, "new");
    // tile lives in the active cluster (index 1), not the first one.
    assert.ok(state.clusters[1].some(col => col.some(t => t.id === "new")));
    assert.ok(!state.clusters[0].some(col => col.some(t => t.id === "new")));
  });
});

describe("buildBootState — tab-set merge", () => {
  it("folds in tab-set sessions without focusing them", () => {
    const { state } = buildBootState({
      urlSession: "main",
      tabSetSessions: ["other"],
    });
    assert.ok(state.tiles.main);
    assert.ok(state.tiles.other);
    assert.strictEqual(state.focusedId, "main");
  });

  it("does not duplicate tab-set sessions that are already present", () => {
    const persisted = persistedV3({
      clusters: [[[{ id: "a", type: "terminal", props: {} }]]],
      focusedTileIdByCluster: ["a"],
    });
    const { state } = buildBootState({ persisted, tabSetSessions: ["a"] });
    assert.strictEqual(Object.keys(state.tiles).length, 1);
  });
});

describe("buildBootState — pure function", () => {
  it("does not mutate inputs", () => {
    const persisted = persistedV3({
      clusters: [[[{ id: "a", type: "terminal", props: {} }]]],
      focusedTileIdByCluster: ["a"],
    });
    const snapshot = JSON.parse(JSON.stringify(persisted));
    buildBootState({ persisted, urlSession: "b" });
    assert.deepStrictEqual(persisted, snapshot);
  });
});
