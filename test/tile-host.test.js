import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

// tile-host has zero imports now (getRenderer is injected), so the
// file:// URL import works without a custom Node loader.
const { createTileHost } = await import(
  new URL("../public/lib/tile-host.js", import.meta.url).href
);

// ── Minimal store ──────────────────────────────────────────────────────
// Uses the v2 multi-cluster shape tile-host now expects. `selectClusterView`
// filters by clusterId; the test store keeps everything in a single
// "default" cluster and derives legacy `order`/`focusedId` fields for tests
// that assert on them.
const DEFAULT_CLUSTER = "default";

function withDerived(state) {
  const tilesForCluster = Object.values(state.tiles)
    .filter(t => t.clusterId === state.activeClusterId)
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const order = tilesForCluster.map(t => t.id);
  const focusedId = state.focusedIdByCluster[state.activeClusterId] ?? null;
  return { ...state, order, focusedId };
}

function emptyState() {
  return withDerived({
    version: 2,
    activeClusterId: DEFAULT_CLUSTER,
    clusters: { [DEFAULT_CLUSTER]: { id: DEFAULT_CLUSTER } },
    tiles: {},
    focusedIdByCluster: { [DEFAULT_CLUSTER]: null },
  });
}

function createTestStore(initial = emptyState()) {
  let state = initial;
  const subs = new Set();

  function notify() { subs.forEach(fn => fn(state)); }

  return {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    dispatch(action) { /* not used by tile-host */ },
    setState(next) {
      // Test-side convenience: accept both the v2 shape and the pre-v2 flat
      // shape (`{tiles, order, focusedId}`) the original tests use. Flat
      // input gets wrapped into the default cluster with x-positions taken
      // from the order array.
      if (next.clusters) {
        // Normalize tiles that are missing clusterId/x. If the caller
        // provided an `order` array, use it for x positions so legacy-style
        // "spread state, set order" inserts still work.
        const normalizedTiles = {};
        const orderArr = next.order;
        Object.entries(next.tiles || {}).forEach(([id, t]) => {
          const idxInOrder = orderArr ? orderArr.indexOf(id) : -1;
          // If the caller supplied an `order` array, trust it as the
          // source of truth for x positions — overrides any existing
          // x on the tile (the whole point of passing `order`).
          const xFromOrder = idxInOrder >= 0 ? idxInOrder : undefined;
          normalizedTiles[id] = {
            ...t,
            id: t.id ?? id,
            clusterId: t.clusterId ?? DEFAULT_CLUSTER,
            x: xFromOrder ?? t.x ?? 0,
          };
        });
        const focusedIdByCluster = next.focusedIdByCluster
          ? next.focusedIdByCluster
          : { ...state.focusedIdByCluster, [DEFAULT_CLUSTER]: next.focusedId ?? null };
        state = withDerived({ ...next, tiles: normalizedTiles, focusedIdByCluster });
      } else {
        const tiles = {};
        const orderArr = next.order || Object.keys(next.tiles || {});
        orderArr.forEach((id, x) => {
          const t = next.tiles?.[id];
          if (t) tiles[id] = { id, type: t.type, props: t.props || {}, x, clusterId: DEFAULT_CLUSTER };
        });
        state = withDerived({
          version: 2,
          activeClusterId: DEFAULT_CLUSTER,
          clusters: { [DEFAULT_CLUSTER]: { id: DEFAULT_CLUSTER } },
          tiles,
          focusedIdByCluster: { [DEFAULT_CLUSTER]: next.focusedId ?? null },
        });
      }
      notify();
    },
    addTile(id, type, props, focus) {
      const nextX = Object.values(state.tiles)
        .filter(t => t.clusterId === DEFAULT_CLUSTER)
        .reduce((m, t) => Math.max(m, (t.x ?? -1) + 1), 0);
      state = withDerived({
        ...state,
        tiles: {
          ...state.tiles,
          [id]: { id, type, props, x: nextX, clusterId: DEFAULT_CLUSTER },
        },
        focusedIdByCluster: focus
          ? { ...state.focusedIdByCluster, [DEFAULT_CLUSTER]: id }
          : state.focusedIdByCluster,
      });
      notify();
    },
    removeTile(id) {
      const { [id]: _removed, ...rest } = state.tiles;
      const focusedIdByCluster = { ...state.focusedIdByCluster };
      if (focusedIdByCluster[DEFAULT_CLUSTER] === id) {
        const remaining = Object.values(rest)
          .filter(t => t.clusterId === DEFAULT_CLUSTER)
          .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
        focusedIdByCluster[DEFAULT_CLUSTER] = remaining[0]?.id || null;
      }
      state = withDerived({ ...state, tiles: rest, focusedIdByCluster });
      notify();
    },
    focusTile(id) {
      state = withDerived({
        ...state,
        focusedIdByCluster: { ...state.focusedIdByCluster, [DEFAULT_CLUSTER]: id },
      });
      notify();
    },
    reorder(order) {
      const tiles = { ...state.tiles };
      order.forEach((id, x) => {
        if (tiles[id]) tiles[id] = { ...tiles[id], x };
      });
      state = withDerived({ ...state, tiles });
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
    });
    return host;
  }

  // ── BUG: refresh — store pre-populated before init ─────────────────
  describe("init with pre-populated store (refresh path)", () => {
    it("activates carousel with all tiles from store", () => {
      store.setState({
        tiles: {
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
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
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
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

      // Now insert fb between s1 and s2 (afterFocus on s1)
      const s = store.getState();
      store.setState({
        ...s,
        tiles: { ...s.tiles, fb: { id: "fb", type: "terminal", props: { sessionName: "fb" } } },
        order: ["s1", "fb", "s2"],
        focusedId: "fb",
      });

      const addOps = carousel.log.filter(l => l.op === "addCard");
      const fbOp = addOps.find(l => l.id === "fb");
      assert.ok(fbOp, "addCard must be called for fb");
      assert.strictEqual(fbOp.position, 1, "fb must be inserted at index 1 (right of s1)");

      // Carousel order should reflect the store order
      assert.deepStrictEqual(carousel.getCards(), ["s1", "fb", "s2"]);
    });
  });

  // ── Remove ─────────────────────────────────────────────────────────
  describe("remove tile", () => {
    it("calls carousel.removeCard", () => {
      store.setState({
        tiles: {
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
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
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
        },
        order: ["s1"],
        focusedId: "s1",
      });

      createHost();
      host.init();

      assert.strictEqual(renderer.mounts[0].mounted, true);

      store.removeTile("s1");
      // removeCard is called — the carousel is responsible for
      // calling adapter.unmount(), which the real carousel does.
      // Our mock doesn't, but the handle tracking should clear.
      assert.strictEqual(host.getHandle("s1"), null);
    });
  });

  // ── Focus ──────────────────────────────────────────────────────────
  describe("focus change", () => {
    it("calls carousel.focusCard", () => {
      store.setState({
        tiles: {
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
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
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
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
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
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
      // Simulate what happens when a renderer dispatches UPDATE_PROPS
      // from inside the focus callback — the store fires subscribers
      // synchronously, which would re-enter reconcile without the guard.
      createHost({
        onFocusChange: (id) => {
          const s = store.getState();
          if (s.tiles[id]) {
            // Mutate state from inside the callback
            store.setState({
              ...s,
              tiles: {
                ...s.tiles,
                [id]: { ...s.tiles[id], props: { ...s.tiles[id].props, touched: true } },
              },
            });
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
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      host = createTileHost({
        store,
        carousel,
        getRenderer: renderer.getRenderer,
        onFocusChange: () => {},
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
          s1: { id: "s1", type: "terminal", props: { sessionName: "s1" } },
          s2: { id: "s2", type: "terminal", props: { sessionName: "s2" } },
        },
        order: ["s1", "s2"],
        focusedId: "s1",
      });

      host = createTileHost({
        store,
        carousel,
        getRenderer: renderer.getRenderer,
        onFocusChange: () => {},
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
