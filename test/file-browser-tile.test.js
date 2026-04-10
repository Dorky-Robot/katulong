/**
 * file-browser-tile: unit tests
 *
 * Asserts the tile's public contract: serialize/restore round-trip and
 * that mount() drives createFileBrowserComponent + loadRoot with the
 * constructor cwd. Uses mock.module to stub the file-browser component
 * and store modules — no DOM, no fetch.
 */

import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";

if (typeof mock.module !== "function") {
  describe("file-browser-tile", () => {
    it("skipped: mock.module not available in this Node version", () => {});
  });
  process.exit(0);
}

const storeUrl = new URL("../public/lib/file-browser/file-browser-store.js", import.meta.url).href;
const componentUrl = new URL("../public/lib/file-browser/file-browser-component.js", import.meta.url).href;

const loadRootCalls = [];
const componentMountCalls = [];
const createComponentCalls = [];

await mock.module(storeUrl, {
  namedExports: {
    createFileBrowserStore: () => ({ __store: true }),
    loadRoot: (store, path) => { loadRootCalls.push({ store, path }); },
  },
});

await mock.module(componentUrl, {
  namedExports: {
    createFileBrowserComponent: (store, opts) => {
      createComponentCalls.push({ store, opts });
      return {
        mount: (el) => { componentMountCalls.push(el); },
        unmount: mock.fn(),
        focus: mock.fn(),
      };
    },
  },
});

globalThis.document = globalThis.document || {
  createElement: () => ({ style: { cssText: "" }, appendChild: () => {} }),
};

const { createFileBrowserTileFactory } = await import(
  "../public/lib/tiles/file-browser-tile.js"
);

function makeEl() {
  const children = [];
  return {
    appendChild: (c) => { children.push(c); return c; },
    innerHTML: "",
    _children: children,
  };
}

describe("file-browser-tile", () => {
  it("serialize → restore round-trip preserves cwd and sessionName", () => {
    const factory = createFileBrowserTileFactory();
    const tile = factory({ cwd: "/Users/foo/project", sessionName: "work" });
    assert.deepEqual(tile.serialize(), {
      type: "file-browser",
      cwd: "/Users/foo/project",
      sessionName: "work",
    });
    // Reconstruct via the factory — same inputs → same serialized shape.
    const restored = factory(tile.serialize());
    assert.deepEqual(restored.serialize(), tile.serialize());
    assert.equal(restored.type, "file-browser");
    assert.equal(restored.getTitle(), "project");
    assert.equal(restored.getIcon(), "folder");
  });

  it("component onClose routes through ctx.requestClose", () => {
    createComponentCalls.length = 0;
    const factory = createFileBrowserTileFactory();
    const tile = factory({ cwd: "/tmp/x", sessionName: "s" });
    const requestClose = mock.fn();
    tile.mount(makeEl(), { requestClose });
    // Grab the onClose the tile wired into the component and invoke it.
    const { opts } = createComponentCalls[createComponentCalls.length - 1];
    assert.equal(typeof opts.onClose, "function");
    opts.onClose();
    assert.equal(requestClose.mock.callCount(), 1);
  });

  it("component onClose is a no-op when ctx has no requestClose", () => {
    createComponentCalls.length = 0;
    const factory = createFileBrowserTileFactory();
    const tile = factory({ cwd: "/tmp/x", sessionName: "s" });
    tile.mount(makeEl(), {}); // no requestClose
    const { opts } = createComponentCalls[createComponentCalls.length - 1];
    // Must not throw — falls back to a no-op when host doesn't supply it.
    assert.doesNotThrow(() => opts.onClose());
  });

  it("mount creates the component and loadRoots the constructor cwd", () => {
    loadRootCalls.length = 0;
    createComponentCalls.length = 0;
    componentMountCalls.length = 0;
    const factory = createFileBrowserTileFactory();
    const tile = factory({ cwd: "/tmp/x", sessionName: "s" });
    const el = makeEl();
    tile.mount(el);
    assert.equal(createComponentCalls.length, 1);
    assert.equal(componentMountCalls.length, 1);
    assert.equal(loadRootCalls.length, 1);
    assert.equal(loadRootCalls[0].path, "/tmp/x");
  });
});
