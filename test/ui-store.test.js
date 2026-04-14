import { describe, it } from "node:test";
import assert from "node:assert";

const { normalize, serialize, EMPTY_STATE, createUiStore } = await import(
  new URL("../public/lib/ui-store.js", import.meta.url).href
);

// Stub localStorage — ui-store calls saveToStorage on every change.
const _storage = {};
globalThis.localStorage = {
  getItem: (k) => _storage[k] ?? null,
  setItem: (k, v) => { _storage[k] = v; },
  removeItem: (k) => { delete _storage[k]; },
};

function makeStore(initial) {
  return createUiStore({ initialState: initial });
}

// ── normalize (v3 shape + migrations) ────────────────────────────────

describe("normalize", () => {
  it("returns EMPTY_STATE for null/undefined/non-object", () => {
    assert.deepStrictEqual(normalize(null), EMPTY_STATE);
    assert.deepStrictEqual(normalize(undefined), EMPTY_STATE);
    assert.deepStrictEqual(normalize(42), EMPTY_STATE);
  });

  it("passes v3 through, dropping empty columns", () => {
    const v3 = {
      version: 3,
      clusters: [[
        [{ id: "a", type: "terminal", props: {} }],
        [], // should be pruned
        [{ id: "b", type: "terminal", props: {} }],
      ]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: ["a"],
    };
    const s = normalize(v3);
    assert.strictEqual(s.version, 3);
    assert.strictEqual(s.clusters.length, 1);
    assert.strictEqual(s.clusters[0].length, 2);
    assert.deepStrictEqual(s.order, ["a", "b"]);
  });

  it("strips unknown fields on v3 tiles (keeps only id/type/props)", () => {
    const v3 = {
      version: 3,
      clusters: [[[{ id: "a", type: "terminal", props: {}, x: 99, clusterId: "legacy" }]]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: ["a"],
    };
    const s = normalize(v3);
    const t = s.clusters[0][0][0];
    assert.deepStrictEqual(Object.keys(t).sort(), ["id", "props", "type"]);
  });

  it("clamps out-of-range activeClusterIdx", () => {
    const s = normalize({
      version: 3,
      clusters: [[[{ id: "a", type: "terminal", props: {} }]]],
      activeClusterIdx: 99,
      focusedTileIdByCluster: ["a"],
    });
    assert.strictEqual(s.activeClusterIdx, 0);
  });

  it("picks head of first column when focused id is missing/invalid", () => {
    const s = normalize({
      version: 3,
      clusters: [[[{ id: "a", type: "terminal", props: {} }]]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: ["ghost"],
    });
    assert.strictEqual(s.focusedId, "a");
  });

  it("rejects tiles without a valid type (but keeps neighbors)", () => {
    const s = normalize({
      version: 3,
      clusters: [[
        [{ id: "good", type: "terminal", props: {} }],
        [{ id: "bad", props: {} }], // no type — whole column drops
      ]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: ["good"],
    });
    assert.deepStrictEqual(s.order, ["good"]);
  });

  it("dedups duplicate tile ids across columns", () => {
    const s = normalize({
      version: 3,
      clusters: [[
        [{ id: "dup", type: "terminal", props: {} }],
        [{ id: "dup", type: "terminal", props: {} }],
      ]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: ["dup"],
    });
    assert.deepStrictEqual(s.order, ["dup"]);
    assert.strictEqual(s.clusters[0].length, 1);
  });
});

// ── ADD_TILE ─────────────────────────────────────────────────────────

describe("ADD_TILE", () => {
  it("adds the first tile as a single-slot column", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    const s = store.getState();
    assert.deepStrictEqual(s.order, ["a"]);
    assert.strictEqual(s.clusters[0].length, 1);
    assert.strictEqual(s.clusters[0][0][0].id, "a");
    assert.ok(s.tiles.a);
  });

  it("appends a new column at the end by default", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    const s = store.getState();
    assert.deepStrictEqual(s.order, ["a", "b", "c"]);
    assert.strictEqual(s.clusters[0].length, 3);
  });

  it("inserts afterFocus — new column immediately after focused tile's", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "mid", type: "terminal", props: {} }, { insertAt: "afterFocus" });
    const s = store.getState();
    assert.deepStrictEqual(s.order, ["a", "mid", "b"]);
  });

  it("inserts after an explicit tile id via insertAfter", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.addTile({ id: "mid", type: "terminal", props: {} }, { insertAfter: "a" });
    assert.deepStrictEqual(store.getState().order, ["a", "mid", "b", "c"]);
  });

  it("does not duplicate existing ids — can shift focus", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    const s = store.getState();
    assert.strictEqual(s.clusters[0].length, 2);
    assert.strictEqual(s.focusedId, "a");
  });

  it("rejects invalid tile payloads", () => {
    const store = makeStore();
    const before = store.getState();
    store.addTile(null);
    store.addTile({});
    store.addTile({ id: "x" });
    assert.strictEqual(store.getState(), before);
  });
});

// ── REMOVE_TILE ──────────────────────────────────────────────────────

describe("REMOVE_TILE", () => {
  it("removes the tile and prunes its now-empty column", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.removeTile("b");
    const s = store.getState();
    assert.ok(!s.tiles.b);
    assert.deepStrictEqual(s.order, ["a", "c"]);
    assert.strictEqual(s.clusters[0].length, 2);
  });

  it("focuses right neighbor when removing focused tile", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.removeTile("b");
    assert.strictEqual(store.getState().focusedId, "c");
  });

  it("focuses left neighbor when removing the last tile", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.focusTile("b");
    store.removeTile("b");
    assert.strictEqual(store.getState().focusedId, "a");
  });

  it("sets focusedId to null when removing the only tile", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.removeTile("a");
    assert.strictEqual(store.getState().focusedId, null);
    assert.deepStrictEqual(store.getState().order, []);
  });

  it("no-ops for unknown id", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    const before = store.getState();
    store.removeTile("nope");
    assert.strictEqual(store.getState(), before);
  });
});

// ── REORDER ──────────────────────────────────────────────────────────

describe("REORDER", () => {
  it("reorders columns by head-tile id", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.reorder(["c", "a", "b"]);
    assert.deepStrictEqual(store.getState().order, ["c", "a", "b"]);
  });

  it("no-ops when order is unchanged", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    const before = store.getState();
    store.reorder(["a", "b"]);
    assert.strictEqual(store.getState(), before);
  });

  it("appends missing columns at the end in their original order", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.reorder(["a", "c"]);
    assert.deepStrictEqual(store.getState().order, ["a", "c", "b"]);
  });

  it("drops unknown ids", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.reorder(["ghost", "a"]);
    assert.deepStrictEqual(store.getState().order, ["a"]);
  });
});

// ── FOCUS_TILE ───────────────────────────────────────────────────────

describe("FOCUS_TILE", () => {
  it("changes focusedId", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.focusTile("b");
    assert.strictEqual(store.getState().focusedId, "b");
  });

  it("no-ops when already focused", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    const before = store.getState();
    store.focusTile("a");
    assert.strictEqual(store.getState(), before);
  });

  it("ignores unknown id", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    const before = store.getState();
    store.focusTile("ghost");
    assert.strictEqual(store.getState(), before);
  });

  it("clears focus when passed null", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.focusTile(null);
    assert.strictEqual(store.getState().focusedId, null);
  });
});

// ── UPDATE_PROPS ─────────────────────────────────────────────────────

describe("UPDATE_PROPS", () => {
  it("shallow-merges patch into props", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: { sessionName: "s1" } });
    store.updateProps("a", { title: "hello" });
    const t = store.getState().tiles.a;
    assert.strictEqual(t.props.sessionName, "s1");
    assert.strictEqual(t.props.title, "hello");
  });

  it("no-ops when patch values are identical", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: { sessionName: "s1" } });
    const before = store.getState();
    store.updateProps("a", { sessionName: "s1" });
    assert.strictEqual(store.getState(), before);
  });

  it("keeps the tile's position across updates", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.updateProps("b", { title: "renamed" });
    assert.deepStrictEqual(store.getState().order, ["a", "b", "c"]);
  });
});

// ── RESET ────────────────────────────────────────────────────────────

describe("RESET", () => {
  it("replaces state via normalize", () => {
    const store = makeStore();
    store.reset({
      version: 3,
      clusters: [[
        [{ id: "x", type: "terminal", props: {} }],
        [{ id: "y", type: "terminal", props: {} }],
      ]],
      activeClusterIdx: 0,
      focusedTileIdByCluster: ["y"],
    });
    const s = store.getState();
    assert.deepStrictEqual(s.order, ["x", "y"]);
    assert.strictEqual(s.focusedId, "y");
  });

  it("accepts legacy v1 shape and migrates to v3", () => {
    const store = makeStore();
    store.reset({
      version: 1,
      tiles: {
        a: { id: "a", type: "terminal", props: {} },
        b: { id: "b", type: "terminal", props: {} },
      },
      order: ["b", "a"],
      focusedId: "b",
    });
    const s = store.getState();
    assert.strictEqual(s.version, 3);
    assert.deepStrictEqual(s.order, ["b", "a"]);
    assert.strictEqual(s.focusedId, "b");
  });
});

// ── serialize ────────────────────────────────────────────────────────

describe("serialize", () => {
  it("emits a clean v3 shape (no derived fields, tiles are dumb)", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    const out = serialize(store.getState());
    assert.strictEqual(out.version, 3);
    assert.strictEqual(out.activeClusterIdx, 0);
    assert.ok(Array.isArray(out.clusters));
    assert.deepStrictEqual(out.clusters[0].map(col => col[0].id), ["a", "b"]);
    assert.strictEqual(out.tiles, undefined);
    assert.strictEqual(out.order, undefined);
    assert.strictEqual(out.focusedId, undefined);
    // Tiles carry only {id, type, props} — no clusterId/x/y.
    assert.deepStrictEqual(Object.keys(out.clusters[0][0][0]).sort(), ["id", "props", "type"]);
  });

  it("filters non-persistable tiles and prunes empty columns", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "ephemeral", props: {} });
    const out = serialize(store.getState(), (type) => type === "terminal");
    assert.strictEqual(out.clusters[0].length, 1);
    assert.strictEqual(out.clusters[0][0][0].id, "a");
  });

  it("nulls out focused entries that point to filtered tiles", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "ephemeral", props: {} }, { focus: true });
    const out = serialize(store.getState(), (type) => type === "terminal");
    assert.strictEqual(out.focusedTileIdByCluster[0], null);
  });
});

// ── clusters ─────────────────────────────────────────────────────────

describe("clusters: initial state", () => {
  it("has exactly one empty cluster with active index 0", () => {
    const store = makeStore();
    const s = store.getState();
    assert.strictEqual(s.activeClusterIdx, 0);
    assert.strictEqual(s.clusters.length, 1);
    assert.deepStrictEqual(s.clusters[0], []);
    assert.deepStrictEqual(s.focusedTileIdByCluster, [null]);
  });

  it("ADD_TILE targets the active cluster by default", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    assert.strictEqual(store.getState().clusters[0][0][0].id, "a");
  });
});

describe("ADD_CLUSTER", () => {
  it("appends an empty cluster and a null focus slot in parallel", () => {
    const store = makeStore();
    store.addCluster();
    const s = store.getState();
    assert.strictEqual(s.clusters.length, 2);
    assert.deepStrictEqual(s.clusters[1], []);
    assert.strictEqual(s.focusedTileIdByCluster[1], null);
    assert.strictEqual(s.activeClusterIdx, 0); // unchanged
  });

  it("can switch to the new cluster on creation", () => {
    const store = makeStore();
    store.addCluster({}, { switchTo: true });
    assert.strictEqual(store.getState().activeClusterIdx, 1);
  });

  it("can insert at an explicit position, shifting the active index", () => {
    const store = makeStore();
    store.addCluster(); // now [0, 1]
    store.switchCluster(1); // active = 1
    store.addCluster({}, { position: 0 }); // inserts before the active
    const s = store.getState();
    assert.strictEqual(s.clusters.length, 3);
    assert.strictEqual(s.activeClusterIdx, 2); // shifted from 1 to 2
  });
});

describe("SWITCH_CLUSTER", () => {
  it("updates activeClusterIdx and re-derives order/focusedId", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.addCluster();
    store.switchCluster(1);
    store.addTile({ id: "b", type: "terminal", props: {} }, { focus: true });
    const s = store.getState();
    assert.strictEqual(s.activeClusterIdx, 1);
    assert.deepStrictEqual(s.order, ["b"]);
    assert.strictEqual(s.focusedId, "b");

    // Switch back — cluster 0's state is remembered.
    store.switchCluster(0);
    const d = store.getState();
    assert.deepStrictEqual(d.order, ["a"]);
    assert.strictEqual(d.focusedId, "a");
  });

  it("no-ops for out-of-range index", () => {
    const store = makeStore();
    const before = store.getState();
    store.switchCluster(99);
    assert.strictEqual(store.getState(), before);
  });

  it("no-ops when already active", () => {
    const store = makeStore();
    const before = store.getState();
    store.switchCluster(0);
    assert.strictEqual(store.getState(), before);
  });
});

describe("REMOVE_CLUSTER", () => {
  it("removes the cluster and all its tiles", () => {
    const store = makeStore();
    store.addCluster({}, { switchTo: true });
    store.addTile({ id: "w1", type: "terminal", props: {} });
    store.addTile({ id: "w2", type: "terminal", props: {} });
    store.switchCluster(0);
    store.removeCluster(1);
    const s = store.getState();
    assert.strictEqual(s.clusters.length, 1);
    assert.ok(!s.tiles.w1);
    assert.ok(!s.tiles.w2);
  });

  it("refuses to remove the last cluster", () => {
    const store = makeStore();
    const before = store.getState();
    store.removeCluster(0);
    assert.strictEqual(store.getState(), before);
  });

  it("clamps activeClusterIdx when removing the active cluster", () => {
    const store = makeStore();
    store.addCluster({}, { switchTo: true }); // active = 1
    store.removeCluster(1);
    assert.strictEqual(store.getState().activeClusterIdx, 0);
  });

  it("shifts activeClusterIdx down when removing a lower-indexed cluster", () => {
    const store = makeStore();
    store.addCluster({}, { switchTo: true }); // active = 1
    store.removeCluster(0);
    assert.strictEqual(store.getState().activeClusterIdx, 0);
    assert.strictEqual(store.getState().clusters.length, 1);
  });
});

describe("cluster-scoped actions", () => {
  it("FOCUS_TILE rejects a tile in a non-active cluster", () => {
    const store = makeStore();
    store.addCluster();
    store.addTile({ id: "w1", type: "terminal", props: {} }, { clusterIdx: 1 });
    const before = store.getState();
    store.focusTile("w1");
    assert.strictEqual(store.getState(), before);
  });

  it("ADD_TILE can target a specific cluster via clusterIdx option", () => {
    const store = makeStore();
    store.addCluster();
    store.addTile({ id: "w1", type: "terminal", props: {} }, { clusterIdx: 1 });
    const s = store.getState();
    // Active cluster (0) is empty; w1 lives in cluster 1.
    assert.deepStrictEqual(s.order, []);
    assert.strictEqual(s.clusters[1][0][0].id, "w1");
  });

  it("REORDER only touches columns in the target cluster", () => {
    const store = makeStore();
    store.addCluster();
    store.addTile({ id: "a", type: "terminal", props: {} }); // cluster 0
    store.addTile({ id: "b", type: "terminal", props: {} }); // cluster 0
    store.addTile({ id: "w1", type: "terminal", props: {} }, { clusterIdx: 1 });
    store.addTile({ id: "w2", type: "terminal", props: {} }, { clusterIdx: 1 });
    store.reorder(["b", "a"]); // cluster 0
    const s = store.getState();
    assert.deepStrictEqual(s.order, ["b", "a"]);
    assert.deepStrictEqual(s.clusters[1].map(c => c[0].id), ["w1", "w2"]);
  });

  it("REMOVE_TILE re-focuses within the removed tile's own cluster", () => {
    const store = makeStore();
    store.addCluster();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "w1", type: "terminal", props: {} }, { clusterIdx: 1 });
    store.addTile({ id: "w2", type: "terminal", props: {} }, { clusterIdx: 1 });
    store.switchCluster(1);
    store.focusTile("w1");
    store.switchCluster(0);
    store.removeTile("w1");
    assert.strictEqual(store.getState().focusedTileIdByCluster[1], "w2");
    assert.strictEqual(store.getState().focusedTileIdByCluster[0], "a");
  });
});

// ── Migrations ───────────────────────────────────────────────────────

describe("v1 → v3 migration via normalize", () => {
  it("wraps v1 tiles into single-slot columns in the v1 order", () => {
    const v1 = {
      version: 1,
      tiles: {
        a: { id: "a", type: "terminal", props: {} },
        b: { id: "b", type: "terminal", props: {} },
      },
      order: ["b", "a"],
      focusedId: "b",
    };
    const v3 = normalize(v1);
    assert.strictEqual(v3.version, 3);
    assert.strictEqual(v3.activeClusterIdx, 0);
    assert.deepStrictEqual(v3.order, ["b", "a"]);
    assert.strictEqual(v3.focusedId, "b");
    assert.strictEqual(v3.clusters[0].length, 2);
  });

  it("backfills missing tiles not in order array (corrupt save)", () => {
    const v1 = {
      version: 1,
      tiles: {
        a: { id: "a", type: "terminal", props: {} },
        b: { id: "b", type: "terminal", props: {} },
        orphan: { id: "orphan", type: "terminal", props: {} },
      },
      order: ["a", "b"],
    };
    const v3 = normalize(v1);
    assert.deepStrictEqual(v3.order, ["a", "b", "orphan"]);
  });
});

describe("v2 → v3 migration via normalize", () => {
  it("promotes v2 clusters to v3 3D array, preserving x order as columns", () => {
    const v2 = {
      version: 2,
      activeClusterId: "default",
      clusters: {
        default: { id: "default" },
        work: { id: "work", name: "Work" },
      },
      tiles: {
        a: { id: "a", type: "terminal", props: {}, clusterId: "default", x: 0 },
        b: { id: "b", type: "terminal", props: {}, clusterId: "default", x: 1 },
        w1: { id: "w1", type: "terminal", props: {}, clusterId: "work", x: 0 },
      },
      focusedIdByCluster: { default: "b", work: "w1" },
    };
    const v3 = normalize(v2);
    assert.strictEqual(v3.version, 3);
    // Active cluster lands at index 0 in the v3 output.
    assert.strictEqual(v3.activeClusterIdx, 0);
    assert.deepStrictEqual(v3.order, ["a", "b"]);
    assert.strictEqual(v3.focusedId, "b");
    assert.strictEqual(v3.clusters.length, 2);
    // Each v2 tile becomes its own single-slot column.
    assert.deepStrictEqual(v3.clusters[0].map(c => c[0].id), ["a", "b"]);
    assert.deepStrictEqual(v3.clusters[1].map(c => c[0].id), ["w1"]);
    // Tiles are dumb: no clusterId or x fields survive.
    const t = v3.clusters[0][0][0];
    assert.deepStrictEqual(Object.keys(t).sort(), ["id", "props", "type"]);
  });
});

describe("round-trip: serialize → normalize", () => {
  it("serialize output normalizes back to equivalent state", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: { sessionName: "a" } }, { focus: true });
    store.addTile({ id: "b", type: "terminal", props: { sessionName: "b" } });
    store.addTile({ id: "c", type: "terminal", props: { sessionName: "c" } }, { insertAt: "afterFocus" });
    const serialized = serialize(store.getState());
    const restored = normalize(serialized);
    assert.deepStrictEqual(restored.order, store.getState().order);
    assert.strictEqual(restored.focusedId, store.getState().focusedId);
  });
});
