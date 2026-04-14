/**
 * file-browser renderer — swap-adjacent-preview logic.
 *
 * Regression guard for MC1b. Before the fix, `onFileOpen` used v2's `.x`
 * coordinate to find an existing preview tile to swap. Under v3 position
 * IS identity (clusters[c][col][row]) and `.x` doesn't exist, so the
 * swap never matched and every file-open inserted a fresh preview instead
 * of replacing the previous one.
 *
 * Scope: covers only the pure `findAdjacentPreviewToSwap` helper that
 * encapsulates the swap decision. End-to-end file-click → dispatch paths
 * are owned by file-browser-tile.test.js which exercises the factory.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { register } from "node:module";

// Minimal localStorage polyfill — file-browser-store.js reads on import.
const storageData = {};
globalThis.localStorage = {
  getItem(k) { return storageData[k] ?? null; },
  setItem(k, v) { storageData[k] = String(v); },
  removeItem(k) { delete storageData[k]; },
};

// Resolve browser-style "/lib/" and "/vendor/" imports to public/ so
// file-browser.js can pull its transitive deps. Same pattern as
// test/file-browser-store.test.js.
const projectRoot = new URL("..", import.meta.url).href;
const resolverCode = `
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/") || specifier.startsWith("/vendor/")) {
    return nextResolve("${projectRoot}public" + specifier, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

const { findAdjacentPreviewToSwap } = await import(
  new URL("../public/lib/tile-renderers/file-browser.js", import.meta.url).href
);

// v3 state factory — keeps tests independent of ui-store internals. Same
// shape as test/selectors.test.js. Position is identity, so each cluster
// is an array of columns, each column an array of rows.
function v3State(clusters, activeClusterIdx = 0) {
  const tiles = {};
  for (const cluster of clusters) {
    for (const column of cluster) {
      for (const tile of column) tiles[tile.id] = tile;
    }
  }
  return { version: 3, clusters, activeClusterIdx, tiles };
}

function tile(id, type, props = {}) {
  return { id, type, props };
}

describe("findAdjacentPreviewToSwap", () => {
  it("returns the preview id when a document tile sits in the column to the right", () => {
    const state = v3State([[
      [tile("fb", "file-browser", { cwd: "/" })],
      [tile("doc1", "document", { filePath: "/a.md" })],
      [tile("term1", "terminal")],
    ]]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "fb"), "doc1");
  });

  it("returns the preview id when an image tile sits in the column to the right", () => {
    const state = v3State([[
      [tile("fb", "file-browser", { cwd: "/" })],
      [tile("img1", "image", { filePath: "/a.png" })],
    ]]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "fb"), "img1");
  });

  it("returns null when the neighbor is not a preview tile", () => {
    const state = v3State([[
      [tile("fb", "file-browser", { cwd: "/" })],
      [tile("term1", "terminal")],
    ]]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "fb"), null);
  });

  it("returns null when the file-browser is the last column (no neighbor)", () => {
    const state = v3State([[
      [tile("term1", "terminal")],
      [tile("fb", "file-browser", { cwd: "/" })],
    ]]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "fb"), null);
  });

  it("returns null for an id not present in the state", () => {
    const state = v3State([[[tile("fb", "file-browser", { cwd: "/" })]]]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "missing"), null);
  });

  it("scopes to the file-browser's own cluster, not neighbors in other clusters", () => {
    const state = v3State([
      [[tile("fb", "file-browser", { cwd: "/" })]],
      [[tile("doc1", "document", { filePath: "/a.md" })]],
    ]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "fb"), null);
  });

  it("simulates the open-twice regression: second open still finds the first preview for swap", () => {
    // After the first onFileOpen, the document tile has been inserted at
    // col+1 relative to the browser. A second onFileOpen must find THAT
    // tile to remove it — otherwise previews accumulate (the v2 bug).
    const state = v3State([[
      [tile("fb", "file-browser", { cwd: "/" })],
      [tile("doc1", "document", { filePath: "/first.md" })],
    ]]);
    assert.strictEqual(findAdjacentPreviewToSwap(state, "fb"), "doc1");
  });
});
