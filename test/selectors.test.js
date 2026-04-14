import { describe, it } from "node:test";
import assert from "node:assert";

const { selectClusterView, getFocusedSession } = await import(
  new URL("../public/lib/selectors.js", import.meta.url).href
);

function makeState(overrides = {}) {
  return {
    version: 2,
    activeClusterId: "default",
    clusters: { default: { id: "default" }, work: { id: "work" } },
    tiles: {
      a: { id: "a", type: "terminal", props: {}, x: 0, clusterId: "default" },
      b: { id: "b", type: "terminal", props: {}, x: 1, clusterId: "default" },
      w1: { id: "w1", type: "terminal", props: {}, x: 0, clusterId: "work" },
    },
    focusedIdByCluster: { default: "b", work: "w1" },
    ...overrides,
  };
}

describe("selectClusterView — basics", () => {
  it("returns tiles and order filtered to the cluster", () => {
    const view = selectClusterView(makeState(), "default");
    assert.deepStrictEqual(Object.keys(view.tiles).sort(), ["a", "b"]);
    assert.deepStrictEqual(view.order, ["a", "b"]);
    assert.strictEqual(view.focusedId, "b");
  });

  it("returns a different view for a different cluster", () => {
    const view = selectClusterView(makeState(), "work");
    assert.deepStrictEqual(Object.keys(view.tiles), ["w1"]);
    assert.deepStrictEqual(view.order, ["w1"]);
    assert.strictEqual(view.focusedId, "w1");
  });

  it("orders tiles by x, not by insertion", () => {
    const state = makeState({
      tiles: {
        t2: { id: "t2", type: "terminal", props: {}, x: 2, clusterId: "default" },
        t0: { id: "t0", type: "terminal", props: {}, x: 0, clusterId: "default" },
        t1: { id: "t1", type: "terminal", props: {}, x: 1, clusterId: "default" },
      },
      focusedIdByCluster: { default: "t0" },
    });
    assert.deepStrictEqual(selectClusterView(state, "default").order, ["t0", "t1", "t2"]);
  });

  it("treats missing x as 0 (sort-stable fallback)", () => {
    const state = makeState({
      tiles: {
        b: { id: "b", type: "terminal", props: {}, x: 5, clusterId: "default" },
        a: { id: "a", type: "terminal", props: {}, clusterId: "default" },
      },
      focusedIdByCluster: { default: "a" },
    });
    // `a` has no x (treated as 0), comes before `b` (x=5)
    assert.deepStrictEqual(selectClusterView(state, "default").order, ["a", "b"]);
  });
});

describe("selectClusterView — edge cases", () => {
  it("returns empty view for unknown cluster id", () => {
    assert.deepStrictEqual(
      selectClusterView(makeState(), "nonexistent"),
      { tiles: {}, order: [], focusedId: null },
    );
  });

  it("returns empty view when cluster exists but has no tiles", () => {
    const state = makeState({
      clusters: { default: { id: "default" }, empty: { id: "empty" } },
      focusedIdByCluster: { default: "b", empty: null },
    });
    assert.deepStrictEqual(
      selectClusterView(state, "empty"),
      { tiles: {}, order: [], focusedId: null },
    );
  });

  it("handles missing focusedIdByCluster entry as null", () => {
    const state = makeState({ focusedIdByCluster: { default: null, work: "w1" } });
    assert.strictEqual(selectClusterView(state, "default").focusedId, null);
  });

  it("handles null/undefined state gracefully", () => {
    assert.deepStrictEqual(
      selectClusterView(null, "default"),
      { tiles: {}, order: [], focusedId: null },
    );
    assert.deepStrictEqual(
      selectClusterView(undefined, "default"),
      { tiles: {}, order: [], focusedId: null },
    );
  });
});

describe("selectClusterView — purity", () => {
  it("does not mutate the input state", () => {
    const state = makeState();
    const snap = JSON.parse(JSON.stringify(state));
    selectClusterView(state, "default");
    assert.deepStrictEqual(state, snap);
  });

  it("returns a fresh tiles object, not a reference into state", () => {
    const state = makeState();
    const view = selectClusterView(state, "default");
    assert.notStrictEqual(view.tiles, state.tiles);
  });
});

describe("getFocusedSession — unchanged", () => {
  it("returns renderer-declared session for the focused tile", () => {
    const state = makeState();
    state.focusedId = "b"; // derived field (tile-host path still reads top-level)
    const getRenderer = () => ({
      describe: (props) => ({ session: props.sessionName || "b" }),
    });
    assert.strictEqual(getFocusedSession(state, getRenderer), "b");
  });

  it("returns null when renderer has no session", () => {
    const state = makeState();
    state.focusedId = "b";
    const getRenderer = () => ({ describe: () => ({}) });
    assert.strictEqual(getFocusedSession(state, getRenderer), null);
  });
});
