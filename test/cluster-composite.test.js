/**
 * Characterization test for the cluster composite tile.
 *
 * The file under test is today called dashboard-tile.js — a CSS-grid
 * composite that mounts N sub-tiles into a grid and cascades lifecycle
 * calls (mount, unmount, focus, blur, resize). This test pins its
 * behavior BEFORE the refocus renames the file to cluster-tile.js and
 * hard-codes slot construction to terminal tiles only.
 *
 * The test uses DOM-level mocks and a fake createTileFn, not real tmux.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// ── Mocks ────────────────────────────────────────────────────────────

function createMockElement(tag) {
  const styles = {};
  const classes = new Set();
  const children = [];
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
    style: new Proxy(styles, { set: (t, k, v) => { t[k] = v; return true; }, get: (t, k) => t[k] || "" }),
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    className: "",
    dataset: {},
    appendChild: (child) => { children.push(child); child.parentElement = el; return child; },
    remove: () => { el.parentElement = null; },
    get parentElement() { return el._parentElement || null; },
    set parentElement(v) { el._parentElement = v; },
    _classes: classes,
    _styles: styles,
    _children: children,
  };
  return el;
}

function createMockSubTile(id) {
  return {
    type: "mock",
    id,
    mount: mock.fn(),
    unmount: mock.fn(),
    focus: mock.fn(),
    blur: mock.fn(),
    resize: mock.fn(),
    getTitle: () => id,
    getIcon: () => "terminal-window",
    serialize: () => ({ type: "mock", sessionName: id }),
  };
}

function setupGlobals() {
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = (tag) => createMockElement(tag);
}

async function importDashboardTile() {
  const url = new URL('../public/lib/tiles/dashboard-tile.js', import.meta.url);
  const mod = await import(url.href + '?t=' + Date.now() + Math.random());
  return mod.createDashboardTileFactory;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('cluster composite (dashboard-tile)', () => {
  let createDashboardTileFactory;
  let createTileFn;
  let tilesCreated;

  beforeEach(async () => {
    setupGlobals();
    createDashboardTileFactory = await importDashboardTile();
    tilesCreated = [];
    createTileFn = mock.fn((type, slot) => {
      const t = createMockSubTile(slot.sessionName || slot.title || `${type}-${tilesCreated.length}`);
      tilesCreated.push(t);
      return t;
    });
  });

  describe('grid layout', () => {
    it('mounts a 2x2 grid with 4 terminal slots', () => {
      const factory = createDashboardTileFactory({ createTileFn });
      const tile = factory({
        cols: 2,
        rows: 2,
        slots: [
          { type: "terminal", sessionName: "a" },
          { type: "terminal", sessionName: "b" },
          { type: "terminal", sessionName: "c" },
          { type: "terminal", sessionName: "d" },
        ],
      });
      const container = createMockElement("div");
      tile.mount(container, { flip: () => {} });
      const gridEl = container._children[0];
      assert.strictEqual(gridEl._styles.display, "grid");
      assert.strictEqual(gridEl._styles.gridTemplateColumns, "repeat(2, 1fr)");
      assert.strictEqual(gridEl._styles.gridTemplateRows, "repeat(2, 1fr)");
      assert.strictEqual(gridEl._children.length, 4);
    });

    it('auto-computes grid from slot count when cols/rows not given', () => {
      const factory = createDashboardTileFactory({ createTileFn });
      const tile = factory({
        slots: [
          { type: "terminal", sessionName: "a" },
          { type: "terminal", sessionName: "b" },
          { type: "terminal", sessionName: "c" },
        ],
      });
      const container = createMockElement("div");
      tile.mount(container, {});
      // ceil(sqrt(3)) = 2 cols, ceil(3/2) = 2 rows
      const gridEl = container._children[0];
      assert.strictEqual(gridEl._styles.gridTemplateColumns, "repeat(2, 1fr)");
      assert.strictEqual(gridEl._styles.gridTemplateRows, "repeat(2, 1fr)");
    });

    it('applies maxCellWidth when specified', () => {
      const factory = createDashboardTileFactory({ createTileFn });
      const tile = factory({
        cols: 3,
        rows: 1,
        maxCellWidth: "400px",
        slots: [
          { type: "terminal", sessionName: "a" },
          { type: "terminal", sessionName: "b" },
          { type: "terminal", sessionName: "c" },
        ],
      });
      const container = createMockElement("div");
      tile.mount(container, {});
      const gridEl = container._children[0];
      assert.strictEqual(gridEl._styles.gridTemplateColumns, "repeat(3, minmax(0, 400px))");
      assert.strictEqual(gridEl._styles.justifyContent, "center");
    });
  });

  describe('lifecycle cascade', () => {
    let tile;
    let container;
    let ctx;

    beforeEach(() => {
      const factory = createDashboardTileFactory({ createTileFn });
      tile = factory({
        cols: 2,
        rows: 1,
        slots: [
          { type: "terminal", sessionName: "dev" },
          { type: "terminal", sessionName: "test" },
        ],
      });
      container = createMockElement("div");
      ctx = { flip: () => {} };
    });

    it('mounts every slot via createTileFn', () => {
      tile.mount(container, ctx);
      assert.strictEqual(createTileFn.mock.callCount(), 2);
      assert.strictEqual(createTileFn.mock.calls[0].arguments[0], "terminal");
      assert.strictEqual(createTileFn.mock.calls[0].arguments[1].sessionName, "dev");
      assert.strictEqual(createTileFn.mock.calls[1].arguments[1].sessionName, "test");
    });

    it('cascades mount() to every sub-tile', () => {
      tile.mount(container, ctx);
      assert.strictEqual(tilesCreated[0].mount.mock.callCount(), 1);
      assert.strictEqual(tilesCreated[1].mount.mock.callCount(), 1);
    });

    it('cascades unmount() to every sub-tile', () => {
      tile.mount(container, ctx);
      tile.unmount();
      assert.strictEqual(tilesCreated[0].unmount.mock.callCount(), 1);
      assert.strictEqual(tilesCreated[1].unmount.mock.callCount(), 1);
    });

    it('focus() only focuses the first sub-tile', () => {
      tile.mount(container, ctx);
      tile.focus();
      assert.strictEqual(tilesCreated[0].focus.mock.callCount(), 1);
      assert.strictEqual(tilesCreated[1].focus.mock.callCount(), 0);
    });

    it('blur() cascades to every sub-tile', () => {
      tile.mount(container, ctx);
      tile.blur();
      assert.strictEqual(tilesCreated[0].blur.mock.callCount(), 1);
      assert.strictEqual(tilesCreated[1].blur.mock.callCount(), 1);
    });

    it('resize() cascades to every sub-tile', () => {
      tile.mount(container, ctx);
      tile.resize();
      assert.strictEqual(tilesCreated[0].resize.mock.callCount(), 1);
      assert.strictEqual(tilesCreated[1].resize.mock.callCount(), 1);
    });
  });

  describe('serialization', () => {
    it('round-trips grid dimensions and slot session names', () => {
      const factory = createDashboardTileFactory({ createTileFn });
      const tile = factory({
        cols: 2,
        rows: 2,
        title: "Cluster",
        slots: [
          { type: "terminal", sessionName: "dev" },
          { type: "terminal", sessionName: "test" },
        ],
      });
      const container = createMockElement("div");
      tile.mount(container, {});
      const serialized = tile.serialize();
      assert.strictEqual(serialized.type, "dashboard");
      assert.strictEqual(serialized.cols, 2);
      assert.strictEqual(serialized.rows, 2);
      assert.strictEqual(serialized.title, "Cluster");
      assert.strictEqual(serialized.slots.length, 2);
      assert.strictEqual(serialized.slots[0].sessionName, "dev");
      assert.strictEqual(serialized.slots[1].sessionName, "test");
    });
  });

  describe('getSubTiles', () => {
    it('exposes the sub-tile array for external inspection', () => {
      const factory = createDashboardTileFactory({ createTileFn });
      const tile = factory({
        cols: 2,
        rows: 1,
        slots: [
          { type: "terminal", sessionName: "a" },
          { type: "terminal", sessionName: "b" },
        ],
      });
      tile.mount(createMockElement("div"), {});
      const subs = tile.getSubTiles();
      assert.strictEqual(subs.length, 2);
      assert.strictEqual(subs[0].index, 0);
      assert.strictEqual(subs[1].index, 1);
    });
  });
});
