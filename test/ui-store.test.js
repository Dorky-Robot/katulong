import { describe, it } from "node:test";
import assert from "node:assert";

const { normalize, serialize, EMPTY_STATE } = await import(
  new URL("../public/lib/ui-store.js", import.meta.url).href
);

// ── normalize ───────────────────────────────────────────────────────

describe("normalize", () => {
  it("returns EMPTY_STATE for null/undefined", () => {
    assert.deepStrictEqual(normalize(null), EMPTY_STATE);
    assert.deepStrictEqual(normalize(undefined), EMPTY_STATE);
    assert.deepStrictEqual(normalize(42), EMPTY_STATE);
  });

  it("assigns x from order array when tiles lack x (migration)", () => {
    const raw = {
      version: 1,
      tiles: {
        a: { id: "a", type: "terminal", props: {} },
        b: { id: "b", type: "terminal", props: {} },
        c: { id: "c", type: "terminal", props: {} },
      },
      order: ["b", "a", "c"],
      focusedId: "a",
    };
    const result = normalize(raw);
    assert.strictEqual(result.tiles.b.x, 0);
    assert.strictEqual(result.tiles.a.x, 1);
    assert.strictEqual(result.tiles.c.x, 2);
    assert.deepStrictEqual(result.order, ["b", "a", "c"]);
    assert.strictEqual(result.focusedId, "a");
  });

  it("preserves x when tiles already have it", () => {
    const raw = {
      version: 1,
      tiles: {
        a: { id: "a", type: "terminal", props: {}, x: 5 },
        b: { id: "b", type: "terminal", props: {}, x: 2 },
      },
      focusedId: "a",
    };
    const result = normalize(raw);
    assert.strictEqual(result.tiles.a.x, 5);
    assert.strictEqual(result.tiles.b.x, 2);
    assert.deepStrictEqual(result.order, ["b", "a"]);
  });

  it("backfills missing tiles not in order array (corrupt save)", () => {
    const raw = {
      version: 1,
      tiles: {
        a: { id: "a", type: "terminal", props: {} },
        b: { id: "b", type: "terminal", props: {} },
        orphan: { id: "orphan", type: "terminal", props: {} },
      },
      order: ["a", "b"], // orphan missing from order
      focusedId: "a",
    };
    const result = normalize(raw);
    assert.strictEqual(result.tiles.a.x, 0);
    assert.strictEqual(result.tiles.b.x, 1);
    assert.strictEqual(result.tiles.orphan.x, 2);
    assert.deepStrictEqual(result.order, ["a", "b", "orphan"]);
  });

  it("defaults focusedId to first tile when missing", () => {
    const raw = {
      tiles: { z: { id: "z", type: "terminal", props: {}, x: 0 } },
    };
    const result = normalize(raw);
    assert.strictEqual(result.focusedId, "z");
  });

  it("rejects tiles with invalid type", () => {
    const raw = {
      tiles: {
        good: { id: "good", type: "terminal", props: {} },
        bad: { id: "bad", props: {} }, // no type
      },
      order: ["good", "bad"],
    };
    const result = normalize(raw);
    assert.ok(result.tiles.good);
    assert.ok(!result.tiles.bad);
    assert.deepStrictEqual(result.order, ["good"]);
  });
});

// ── reducer (via createUiStore) ─────────────────────────────────────

// createUiStore calls normalize on initialState and wraps the reducer.
// We test through it to exercise the real dispatch path.

// Stub localStorage — ui-store calls saveToStorage on every change
const _storage = {};
globalThis.localStorage = {
  getItem: (k) => _storage[k] ?? null,
  setItem: (k, v) => { _storage[k] = v; },
  removeItem: (k) => { delete _storage[k]; },
};

const { createUiStore } = await import(
  new URL("../public/lib/ui-store.js", import.meta.url).href
);

function makeStore(initial) {
  return createUiStore({ initialState: initial });
}

describe("ADD_TILE", () => {
  it("assigns x = 0 to the first tile", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    const s = store.getState();
    assert.strictEqual(s.tiles.a.x, 0);
    assert.deepStrictEqual(s.order, ["a"]);
  });

  it("appends at end by default (x = nextX)", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    const s = store.getState();
    assert.strictEqual(s.tiles.a.x, 0);
    assert.strictEqual(s.tiles.b.x, 1);
    assert.strictEqual(s.tiles.c.x, 2);
    assert.deepStrictEqual(s.order, ["a", "b", "c"]);
  });

  it("inserts afterFocus — shifts tiles to the right", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "b", type: "terminal", props: {} });
    // Focus is on "a" (x=0). Insert "mid" after focus.
    store.addTile({ id: "mid", type: "terminal", props: {} }, { insertAt: "afterFocus" });
    const s = store.getState();
    assert.strictEqual(s.tiles.a.x, 0);
    assert.strictEqual(s.tiles.mid.x, 1);
    assert.strictEqual(s.tiles.b.x, 2); // shifted from 1 → 2
    assert.deepStrictEqual(s.order, ["a", "mid", "b"]);
  });

  it("does not duplicate — optionally focuses existing tile", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} }, { focus: true });
    // Try to add "a" again with focus
    store.addTile({ id: "a", type: "terminal", props: {} }, { focus: true });
    const s = store.getState();
    assert.strictEqual(Object.keys(s.tiles).length, 2);
    assert.strictEqual(s.focusedId, "a");
  });
});

describe("REMOVE_TILE", () => {
  it("removes tile and derives new order", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.removeTile("b");
    const s = store.getState();
    assert.ok(!s.tiles.b);
    assert.deepStrictEqual(s.order, ["a", "c"]);
  });

  it("focuses right neighbor when removing focused tile", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} }, { focus: true });
    store.addTile({ id: "c", type: "terminal", props: {} });
    // b is focused, remove it — should focus c (right neighbor)
    store.removeTile("b");
    assert.strictEqual(store.getState().focusedId, "c");
  });

  it("focuses left neighbor when removing last tile", () => {
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

describe("REORDER", () => {
  it("reassigns x coordinates to match new order", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    store.reorder(["c", "a", "b"]);
    const s = store.getState();
    assert.strictEqual(s.tiles.c.x, 0);
    assert.strictEqual(s.tiles.a.x, 1);
    assert.strictEqual(s.tiles.b.x, 2);
    assert.deepStrictEqual(s.order, ["c", "a", "b"]);
  });

  it("no-ops when order is unchanged", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    const before = store.getState();
    store.reorder(["a", "b"]);
    assert.strictEqual(store.getState(), before);
  });

  it("appends missing tiles at the end", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    store.addTile({ id: "c", type: "terminal", props: {} });
    // Only specify a,c — b should be appended
    store.reorder(["a", "c"]);
    const s = store.getState();
    assert.deepStrictEqual(s.order, ["a", "c", "b"]);
    assert.strictEqual(s.tiles.a.x, 0);
    assert.strictEqual(s.tiles.c.x, 1);
    assert.strictEqual(s.tiles.b.x, 2);
  });

  it("drops unknown ids", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.reorder(["ghost", "a"]);
    assert.deepStrictEqual(store.getState().order, ["a"]);
  });
});

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
});

describe("UPDATE_PROPS", () => {
  it("shallow-merges patch into props, preserves x", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: { sessionName: "s1" } });
    store.updateProps("a", { title: "hello" });
    const t = store.getState().tiles.a;
    assert.strictEqual(t.props.sessionName, "s1");
    assert.strictEqual(t.props.title, "hello");
    assert.strictEqual(t.x, 0); // x preserved
  });

  it("no-ops when patch values are identical", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: { sessionName: "s1" } });
    const before = store.getState();
    store.updateProps("a", { sessionName: "s1" });
    assert.strictEqual(store.getState(), before);
  });
});

describe("RESET", () => {
  it("normalizes the provided state (backfills x from order)", () => {
    const store = makeStore();
    store.reset({
      tiles: {
        x: { id: "x", type: "terminal", props: {} },
        y: { id: "y", type: "terminal", props: {} },
      },
      order: ["y", "x"],
      focusedId: "y",
    });
    const s = store.getState();
    assert.strictEqual(s.tiles.y.x, 0);
    assert.strictEqual(s.tiles.x.x, 1);
    assert.deepStrictEqual(s.order, ["y", "x"]);
    assert.strictEqual(s.focusedId, "y");
  });

  it("preserves x when tiles already have it", () => {
    const store = makeStore();
    store.reset({
      tiles: {
        a: { id: "a", type: "terminal", props: {}, x: 10 },
        b: { id: "b", type: "terminal", props: {}, x: 3 },
      },
      focusedId: "b",
    });
    const s = store.getState();
    assert.strictEqual(s.tiles.a.x, 10);
    assert.strictEqual(s.tiles.b.x, 3);
    assert.deepStrictEqual(s.order, ["b", "a"]);
  });
});

describe("serialize", () => {
  it("includes x on tiles and derives order", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "terminal", props: {} });
    const out = serialize(store.getState());
    assert.strictEqual(out.tiles.a.x, 0);
    assert.strictEqual(out.tiles.b.x, 1);
    assert.deepStrictEqual(out.order, ["a", "b"]);
  });

  it("filters non-persistable tiles", () => {
    const store = makeStore();
    store.addTile({ id: "a", type: "terminal", props: {} });
    store.addTile({ id: "b", type: "ephemeral", props: {} });
    const out = serialize(store.getState(), (type) => type === "terminal");
    assert.ok(out.tiles.a);
    assert.ok(!out.tiles.b);
    assert.deepStrictEqual(out.order, ["a"]);
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
    for (const id of restored.order) {
      assert.strictEqual(restored.tiles[id].x, store.getState().tiles[id].x);
    }
  });

  it("old format (no x) round-trips through normalize correctly", () => {
    // Simulate what loadFromStorage returns for pre-coordinate persistence
    const oldFormat = {
      version: 1,
      tiles: {
        s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
        s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
      },
      order: ["s2", "s1"],
      focusedId: "s2",
    };
    const restored = normalize(oldFormat);
    assert.deepStrictEqual(restored.order, ["s2", "s1"]);
    assert.strictEqual(restored.tiles.s2.x, 0);
    assert.strictEqual(restored.tiles.s1.x, 1);
    assert.strictEqual(restored.focusedId, "s2");
  });
});
