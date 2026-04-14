import { describe, it } from "node:test";
import assert from "node:assert";

const { selectClusterView, selectColumns, tileLocator, getFocusedSession } = await import(
  new URL("../public/lib/selectors.js", import.meta.url).href
);

// ── Helpers ────────────────────────────────────────────────────────────
// Build a v3 state directly (no need to go through reducers for selector
// tests). `withDerived` is inlined here to keep selector tests independent
// of ui-store internals.
function v3State({ clusters, activeClusterIdx = 0, focusedTileIdByCluster }) {
  const tiles = {};
  for (const cluster of clusters) {
    for (const column of cluster) {
      for (const tile of column) tiles[tile.id] = tile;
    }
  }
  const active = clusters[activeClusterIdx] || [];
  const order = [];
  for (const column of active) for (const tile of column) order.push(tile.id);
  return {
    version: 3,
    clusters,
    activeClusterIdx,
    focusedTileIdByCluster,
    tiles,
    order,
    focusedId: focusedTileIdByCluster[activeClusterIdx] ?? null,
  };
}

function tile(id, extraProps = {}) {
  return { id, type: "terminal", props: { sessionName: id, ...extraProps } };
}

describe("selectClusterView — basics", () => {
  it("returns tiles and order filtered to the cluster", () => {
    const state = v3State({
      clusters: [
        [[tile("a")], [tile("b")]],
        [[tile("w1")]],
      ],
      focusedTileIdByCluster: ["b", "w1"],
    });
    const view = selectClusterView(state, 0);
    assert.deepStrictEqual(Object.keys(view.tiles).sort(), ["a", "b"]);
    assert.deepStrictEqual(view.order, ["a", "b"]);
    assert.strictEqual(view.focusedId, "b");
  });

  it("returns a different view for a different cluster", () => {
    const state = v3State({
      clusters: [
        [[tile("a")], [tile("b")]],
        [[tile("w1")]],
      ],
      focusedTileIdByCluster: ["b", "w1"],
    });
    const view = selectClusterView(state, 1);
    assert.deepStrictEqual(Object.keys(view.tiles), ["w1"]);
    assert.deepStrictEqual(view.order, ["w1"]);
    assert.strictEqual(view.focusedId, "w1");
  });

  it("orders tiles column-major top→bottom within multi-row columns", () => {
    const state = v3State({
      clusters: [[
        [tile("c0r0"), tile("c0r1")],
        [tile("c1r0")],
        [tile("c2r0"), tile("c2r1"), tile("c2r2")],
      ]],
      focusedTileIdByCluster: ["c0r0"],
    });
    assert.deepStrictEqual(
      selectClusterView(state, 0).order,
      ["c0r0", "c0r1", "c1r0", "c2r0", "c2r1", "c2r2"],
    );
  });
});

describe("selectClusterView — edge cases", () => {
  it("returns empty view for out-of-range cluster index", () => {
    const state = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    assert.deepStrictEqual(
      selectClusterView(state, 5),
      { tiles: {}, order: [], focusedId: null },
    );
  });

  it("returns empty view when cluster exists but has no tiles", () => {
    const state = v3State({
      clusters: [[[tile("a")]], []],
      focusedTileIdByCluster: ["a", null],
    });
    assert.deepStrictEqual(
      selectClusterView(state, 1),
      { tiles: {}, order: [], focusedId: null },
    );
  });

  it("handles missing focusedTileIdByCluster entry as null", () => {
    const state = {
      version: 3,
      clusters: [[[tile("a")]]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: [],
    };
    assert.strictEqual(selectClusterView(state, 0).focusedId, null);
  });

  it("handles null/undefined state gracefully", () => {
    assert.deepStrictEqual(
      selectClusterView(null, 0),
      { tiles: {}, order: [], focusedId: null },
    );
    assert.deepStrictEqual(
      selectClusterView(undefined, 0),
      { tiles: {}, order: [], focusedId: null },
    );
  });
});

describe("selectClusterView — purity", () => {
  it("does not mutate the input state", () => {
    const state = v3State({
      clusters: [[[tile("a")], [tile("b")]]],
      focusedTileIdByCluster: ["b"],
    });
    const snap = JSON.parse(JSON.stringify(state));
    selectClusterView(state, 0);
    assert.deepStrictEqual(state, snap);
  });

  it("returns a fresh tiles object, not a reference into state", () => {
    const state = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    const view = selectClusterView(state, 0);
    assert.notStrictEqual(view.tiles, state.tiles);
  });
});

describe("selectColumns", () => {
  it("returns one entry per column, each keyed by its head tile id", () => {
    const state = v3State({
      clusters: [[
        [tile("c0head"), tile("c0row1")],
        [tile("c1only")],
      ]],
      focusedTileIdByCluster: ["c0head"],
    });
    assert.deepStrictEqual(selectColumns(state, 0), [
      { id: "c0head", tileIds: ["c0head", "c0row1"] },
      { id: "c1only", tileIds: ["c1only"] },
    ]);
  });

  it("returns [] for out-of-range cluster index", () => {
    const state = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    assert.deepStrictEqual(selectColumns(state, 3), []);
  });

  it("returns [] for null/undefined state", () => {
    assert.deepStrictEqual(selectColumns(null, 0), []);
    assert.deepStrictEqual(selectColumns(undefined, 0), []);
  });
});

describe("tileLocator", () => {
  it("resolves tile ids to {c, col, row, tile} paths", () => {
    const state = v3State({
      clusters: [
        [[tile("a")], [tile("b"), tile("c")]],
        [[tile("w1")]],
      ],
      focusedTileIdByCluster: ["a", "w1"],
    });
    const loc = tileLocator(state);
    assert.deepStrictEqual(
      { ...loc.get("a"), tile: undefined },
      { c: 0, col: 0, row: 0, tile: undefined },
    );
    assert.strictEqual(loc.get("a").tile.id, "a");
    assert.deepStrictEqual(
      { ...loc.get("c"), tile: undefined },
      { c: 0, col: 1, row: 1, tile: undefined },
    );
    assert.deepStrictEqual(
      { ...loc.get("w1"), tile: undefined },
      { c: 1, col: 0, row: 0, tile: undefined },
    );
  });

  it("returns null for unknown ids", () => {
    const state = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    const loc = tileLocator(state);
    assert.strictEqual(loc.get("nope"), null);
    assert.strictEqual(loc.has("nope"), false);
    assert.strictEqual(loc.has("a"), true);
  });

  it("memoizes per state reference (same state → same locator)", () => {
    const state = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    assert.strictEqual(tileLocator(state), tileLocator(state));
  });

  it("rebuilds for a new state reference", () => {
    const s1 = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    const s2 = v3State({
      clusters: [[[tile("a")], [tile("b")]]],
      focusedTileIdByCluster: ["a"],
    });
    const l1 = tileLocator(s1);
    const l2 = tileLocator(s2);
    assert.notStrictEqual(l1, l2);
    assert.strictEqual(l1.has("b"), false);
    assert.strictEqual(l2.has("b"), true);
  });

  it("ids() and size() reflect the whole workspace", () => {
    const state = v3State({
      clusters: [
        [[tile("a")], [tile("b")]],
        [[tile("w1")]],
      ],
      focusedTileIdByCluster: ["a", "w1"],
    });
    const loc = tileLocator(state);
    assert.deepStrictEqual(loc.ids().sort(), ["a", "b", "w1"]);
    assert.strictEqual(loc.size(), 3);
  });

  it("returns an empty locator for null/undefined state", () => {
    const loc = tileLocator(null);
    assert.strictEqual(loc.get("x"), null);
    assert.strictEqual(loc.has("x"), false);
    assert.strictEqual(loc.size(), 0);
    assert.deepStrictEqual(loc.ids(), []);
  });
});

describe("getFocusedSession — unchanged", () => {
  it("returns renderer-declared session for the focused tile", () => {
    const state = v3State({
      clusters: [[[tile("a")], [tile("b")]]],
      focusedTileIdByCluster: ["b"],
    });
    const getRenderer = () => ({
      describe: (props) => ({ session: props.sessionName }),
    });
    assert.strictEqual(getFocusedSession(state, getRenderer), "b");
  });

  it("returns null when renderer has no session", () => {
    const state = v3State({
      clusters: [[[tile("a")]]],
      focusedTileIdByCluster: ["a"],
    });
    const getRenderer = () => ({ describe: () => ({}) });
    assert.strictEqual(getFocusedSession(state, getRenderer), null);
  });
});
