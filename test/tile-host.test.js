import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const { createTileHost } = await import(
  new URL("../public/lib/tile-host.js", import.meta.url).href
);

// ── Minimal v3-shape store ──────────────────────────────────────────────
// tile-host reads via `selectClusterView`, which expects the v3 3D shape.
// This store keeps a single cluster and maintains derived `tiles`/`order`/
// `focusedId` fields for consumers that peek at top-level state.

function withDerived(state) {
  const tiles = {};
  for (const cluster of state.clusters) {
    for (const column of cluster) {
      for (const tile of column) tiles[tile.id] = tile;
    }
  }
  const active = state.clusters[state.activeClusterIdx] || [];
  const order = [];
  for (const column of active) for (const tile of column) order.push(tile.id);
  const focusedId = state.focusedTileIdByCluster[state.activeClusterIdx] ?? null;
  return { ...state, tiles, order, focusedId };
}

function emptyState() {
  return withDerived({
    version: 3,
    clusters: [[]],
    activeClusterIdx: 0,
    focusedTileIdByCluster: [null],
  });
}

function createTestStore(initial = emptyState()) {
  let state = initial;
  const subs = new Set();

  function notify() { subs.forEach(fn => fn(state)); }

  // Build a v3 state from legacy {tiles, order, focusedId} test input.
  // Each tile becomes a single-slot column, preserving `order`.
  function fromFlat({ tiles = {}, order, focusedId = null }) {
    const orderArr = order || Object.keys(tiles);
    const cluster = [];
    const seen = new Set();
    for (const id of orderArr) {
      if (seen.has(id) || !tiles[id]) continue;
      seen.add(id);
      const t = tiles[id];
      cluster.push([{ id, type: t.type, props: t.props || {} }]);
    }
    for (const [id, t] of Object.entries(tiles)) {
      if (seen.has(id) || !t) continue;
      seen.add(id);
      cluster.push([{ id, type: t.type, props: t.props || {} }]);
    }
    return withDerived({
      version: 3,
      clusters: [cluster],
      activeClusterIdx: 0,
      focusedTileIdByCluster: [focusedId],
    });
  }

  return {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    dispatch(_action) { /* not used by tile-host */ },
    setState(next) {
      // Accept either v3 ({clusters, ...}) or flat ({tiles, order, focusedId}).
      if (next.clusters) {
        state = withDerived({
          version: 3,
          activeClusterIdx: 0,
          focusedTileIdByCluster: [null],
          ...next,
        });
      } else {
        state = fromFlat(next);
      }
      notify();
    },
    addTile(id, type, props, focus) {
      const cluster = state.clusters[0].slice();
      cluster.push([{ id, type, props }]);
      const focusedTileIdByCluster = focus
        ? [id]
        : state.focusedTileIdByCluster.slice();
      state = withDerived({
        ...state,
        clusters: [cluster],
        focusedTileIdByCluster,
      });
      notify();
    },
    removeTile(id) {
      const cluster = state.clusters[0];
      const orderPrev = [];
      for (const col of cluster) for (const t of col) orderPrev.push(t.id);
      const removedIdx = orderPrev.indexOf(id);
      const newCluster = [];
      for (const col of cluster) {
        const filtered = col.filter(t => t.id !== id);
        if (filtered.length > 0) newCluster.push(filtered);
      }
      const nextOrder = [];
      for (const col of newCluster) for (const t of col) nextOrder.push(t.id);
      const focusedTileIdByCluster = state.focusedTileIdByCluster.slice();
      if (focusedTileIdByCluster[0] === id) {
        focusedTileIdByCluster[0] =
          nextOrder[removedIdx] || nextOrder[removedIdx - 1] || null;
      }
      state = withDerived({
        ...state,
        clusters: [newCluster],
        focusedTileIdByCluster,
      });
      notify();
    },
    focusTile(id) {
      state = withDerived({
        ...state,
        focusedTileIdByCluster: [id],
      });
      notify();
    },
    reorder(order) {
      const cluster = state.clusters[0];
      const byHead = new Map();
      for (const col of cluster) byHead.set(col[0].id, col);
      const seen = new Set();
      const newCluster = [];
      for (const id of order) {
        if (seen.has(id)) continue;
        const col = byHead.get(id);
        if (col) { newCluster.push(col); seen.add(id); }
      }
      for (const col of cluster) {
        if (!seen.has(col[0].id)) { newCluster.push(col); seen.add(col[0].id); }
      }
      state = withDerived({ ...state, clusters: [newCluster] });
      notify();
    },
  };
}

// ── Fake renderer ──────────────────────────────────────────────────────
function createFakeRenderer() {
  const mounts = [];
  return {
    mounts,
    getRenderer(type) {
      if (type !== "terminal") return null;
      return {
        type: "terminal",
        describe(props) {
          return {
            title: props.sessionName || "terminal", icon: "t", persistable: true,
            session: props.sessionName || null, updatesUrl: true,
            renameable: true, handlesDnd: false,
          };
        },
        mount(_el, { id, props }) {
          const entry = { id, mounted: true };
          mounts.push(entry);
          return {
            unmount() { entry.mounted = false; },
            focus() {},
            blur() {},
            resize() {},
            getSessions() { return [props.sessionName].filter(Boolean); },
            tile: { sessionName: props.sessionName || id },
          };
        },
      };
    },
  };
}

// ── Mock carousel ──────────────────────────────────────────────────────
function createMockCarousel() {
  let active = false;
  let cards = [];
  let focusedId = null;
  const log = [];

  return {
    log,
    isActive: () => active,
    getCards: () => [...cards],
    getFocusedCard: () => focusedId,

    activate(tiles, focused) {
      log.push({ op: "activate", ids: tiles.map(t => t.id), focused });
      active = true;
      cards = tiles.map(t => t.id);
      focusedId = focused || cards[0] || null;
      for (const { tile } of tiles) tile.mount({}, {});
    },

    addCard(id, tile, position) {
      log.push({ op: "addCard", id, position });
      if (!active) return;
      if (cards.includes(id)) return;
      if (typeof position === "number") cards.splice(position, 0, id);
      else cards.push(id);
      tile.mount({}, {});
    },

    removeCard(id) {
      log.push({ op: "removeCard", id });
      cards = cards.filter(c => c !== id);
      if (focusedId === id) focusedId = cards[0] || null;
    },

    focusCard(id) {
      log.push({ op: "focusCard", id });
      focusedId = id;
    },

    reorderCards(order) {
      log.push({ op: "reorderCards", order: [...order] });
      cards = [...order];
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("tile-host", () => {
  let store, carousel, renderer, host;

  beforeEach(() => {
    store = createTestStore();
    carousel = createMockCarousel();
    renderer = createFakeRenderer();
  });

  function createHost(opts = {}) {
    host = createTileHost({
      store,
      carousel,
      getRenderer: renderer.getRenderer,
      onFocusChange: opts.onFocusChange || (() => {}),
      onTileRemoved: opts.onTileRemoved,
    });
    return host;
  }

  // ── BUG: refresh — store pre-populated before init ─────────────────
  describe("init with pre-populated store (refresh path)", () => {
    it("activates carousel with all tiles from store", () => {
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      const op = carousel.log.find(l => l.op === "activate");
      assert.ok(op, "carousel.activate must be called");
      assert.deepStrictEqual(op.ids, ["s1", "s2"]);
      assert.strictEqual(op.focused, "s1");
    });

    it("mounts every tile via the renderer", () => {
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
        },
        order: ["s1"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      assert.strictEqual(renderer.mounts.length, 1);
      assert.strictEqual(renderer.mounts[0].id, "s1");
      assert.strictEqual(renderer.mounts[0].mounted, true);
    });
  });

  // ── BUG: add tile from empty — tab shows but tile doesn't ──────────
  describe("add tile to empty store after init", () => {
    it("activates carousel when first tile is added", () => {
      createHost();
      host.init();

      assert.strictEqual(carousel.isActive(), false);
      assert.strictEqual(carousel.log.length, 0);

      store.addTile("s1", "terminal", { sessionName: "s1" }, true);

      const op = carousel.log.find(l => l.op === "activate");
      assert.ok(op, "carousel.activate must fire on first tile add");
      assert.deepStrictEqual(op.ids, ["s1"]);
      assert.strictEqual(renderer.mounts.length, 1);
    });

    it("uses addCard for subsequent tiles", () => {
      createHost();
      host.init();

      store.addTile("s1", "terminal", { sessionName: "s1" }, true);
      store.addTile("s2", "terminal", { sessionName: "s2" }, true);

      const addOps = carousel.log.filter(l => l.op === "addCard");
      assert.strictEqual(addOps.length, 1, "second tile should use addCard");
      assert.strictEqual(addOps[0].id, "s2");
      assert.strictEqual(renderer.mounts.length, 2);
    });

    it("inserts new tile at the correct position from state.order", () => {
      // Simulate afterFocus: store already has [s1, s2], focus on s1.
      // A new tile 'fb' is inserted at index 1 (right of s1).
      createHost();
      host.init();

      store.addTile("s1", "terminal", { sessionName: "s1" }, true);
      store.addTile("s2", "terminal", { sessionName: "s2" }, false);

      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          fb: { type: "terminal", props: { sessionName: "fb" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "fb", "s2"],
        focusedId: "fb",
      });

      const addOps = carousel.log.filter(l => l.op === "addCard");
      const fbOp = addOps.find(l => l.id === "fb");
      assert.ok(fbOp, "addCard must be called for fb");
      assert.strictEqual(fbOp.position, 1, "fb must be inserted at index 1 (right of s1)");

      assert.deepStrictEqual(carousel.getCards(), ["s1", "fb", "s2"]);
    });
  });

  // ── Remove ─────────────────────────────────────────────────────────
  describe("remove tile", () => {
    it("calls carousel.removeCard", () => {
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      store.removeTile("s2");

      const op = carousel.log.find(l => l.op === "removeCard");
      assert.ok(op, "carousel.removeCard must be called");
      assert.strictEqual(op.id, "s2");
    });

    it("unmounts the renderer handle", () => {
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
        },
        order: ["s1"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      assert.strictEqual(renderer.mounts[0].mounted, true);

      store.removeTile("s1");
      assert.strictEqual(host.getHandle("s1"), null);
    });
  });

  // ── Focus ──────────────────────────────────────────────────────────
  describe("focus change", () => {
    it("calls carousel.focusCard", () => {
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      store.focusTile("s2");

      const ops = carousel.log.filter(l => l.op === "focusCard");
      const last = ops[ops.length - 1];
      assert.ok(last);
      assert.strictEqual(last.id, "s2");
    });

    it("fires onFocusChange with tile type", () => {
      const changes = [];
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost({ onFocusChange: (id, type) => changes.push({ id, type }) });
      host.init();

      // init fires for initial focus (prev null → s1)
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].id, "s1");

      store.focusTile("s2");
      assert.strictEqual(changes.length, 2);
      assert.deepStrictEqual(changes[1], { id: "s2", type: "terminal" });
    });
  });

  // ── Reorder ────────────────────────────────────────────────────────
  describe("reorder", () => {
    it("calls carousel.reorderCards", () => {
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      store.reorder(["s2", "s1"]);

      const ops = carousel.log.filter(l => l.op === "reorderCards");
      assert.ok(ops.length > 0);
      assert.deepStrictEqual(ops[ops.length - 1].order, ["s2", "s1"]);
    });
  });

  // ── Destroy ────────────────────────────────────────────────────────
  describe("destroy", () => {
    it("stops reacting to store changes", () => {
      createHost();
      host.init();

      store.addTile("s1", "terminal", { sessionName: "s1" }, true);
      const before = carousel.log.length;

      host.destroy();

      store.addTile("s2", "terminal", { sessionName: "s2" }, true);
      assert.strictEqual(carousel.log.length, before, "no carousel calls after destroy");
    });
  });

  // ── Re-entrancy guard ──────────────────────────────────────────────
  describe("re-entrancy", () => {
    it("does not double-mount when onFocusChange triggers a dispatch", () => {
      createHost({
        onFocusChange: (id) => {
          const s = store.getState();
          if (s.tiles[id]) {
            // Mutate state from inside the callback via flat setState
            const tiles = {};
            for (const tid of s.order) {
              const existing = s.tiles[tid];
              tiles[tid] = {
                type: existing.type,
                props: tid === id
                  ? { ...existing.props, touched: true }
                  : existing.props,
              };
            }
            store.setState({ tiles, order: s.order, focusedId: s.focusedId });
          }
        },
      });
      host.init();

      store.addTile("s1", "terminal", { sessionName: "s1" }, true);

      assert.strictEqual(renderer.mounts.length, 1, "exactly one mount, not two");
    });
  });

  // ── onTileRemoved callback ────────────────────────────────────────
  describe("onTileRemoved", () => {
    it("fires with tile id and handle when a tile is removed", () => {
      const removed = [];
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost({
        onTileRemoved: (id, handle) => removed.push({ id, sessions: handle.getSessions?.() }),
      });
      host.init();

      store.removeTile("s2");

      assert.strictEqual(removed.length, 1);
      assert.strictEqual(removed[0].id, "s2");
      assert.deepStrictEqual(removed[0].sessions, ["s2"]);
    });

    it("fires for each tile on bulk removal (RESET to empty)", () => {
      const removed = [];
      store.setState({
        tiles: {
          s1: { type: "terminal", props: { sessionName: "s1" } },
          s2: { type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      createHost({
        onTileRemoved: (id, handle) => removed.push({ id, sessions: handle.getSessions?.() }),
      });
      host.init();

      // Simulate RESET to empty state
      store.setState({ tiles: {}, order: [], focusedId: null });

      assert.strictEqual(removed.length, 2, "onTileRemoved fires for each tile");
      const ids = removed.map(r => r.id).sort();
      assert.deepStrictEqual(ids, ["s1", "s2"]);
    });
  });
});
