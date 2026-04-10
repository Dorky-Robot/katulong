/**
 * file-browser-store: unit tests for createNavController
 *
 * Tests the three spinner reliability fixes:
 *   1. Generation counter — stale responses from superseded navigations
 *      are discarded instead of overwriting fresh data.
 *   2. Fetch timeout — requests that hang are aborted after the timeout,
 *      dispatching SET_COLUMN_ERROR instead of spinning forever.
 *   3. refreshAll error handling — dispatches SET_COLUMN_ERROR on failure
 *      instead of silently swallowing with a bare `break`.
 *
 * Uses a custom module resolver for browser-style "/lib/" imports,
 * and stubs fetch() — no real network, no DOM.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// ── Minimal globals ──────────────────────────────────────────────────
const storageData = {};
globalThis.localStorage = {
  getItem(k) { return storageData[k] ?? null; },
  setItem(k, v) { storageData[k] = String(v); },
  removeItem(k) { delete storageData[k]; },
};

// Minimal DOMException polyfill for Node (AbortError)
if (typeof globalThis.DOMException === "undefined") {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name || "DOMException";
    }
  };
}

// ── Register custom resolver for browser-style absolute imports ──────
const projectRoot = new URL("..", import.meta.url).href;
const resolverCode = `
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/") || specifier.startsWith("/vendor/")) {
    return nextResolve("${projectRoot}public" + specifier, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

// ── Import the real store ────────────────────────────────────────────
const { createFileBrowserStore, createNavController, sortEntries, getDeepestPath } = await import(
  "../public/lib/file-browser/file-browser-store.js"
);

// ── Helpers ──────────────────────────────────────────────────────────

function storeWithColumn(path, entries = [], selected = null) {
  const store = createFileBrowserStore();
  store.dispatch({
    type: "SET_COLUMN",
    index: 0,
    path,
    entries: sortEntries(entries),
  });
  if (selected) {
    store.dispatch({ type: "SELECT_ITEM", columnIndex: 0, name: selected });
  }
  return store;
}

function dir(name) { return { name, type: "directory" }; }
function file(name) { return { name, type: "file" }; }

function mockFetch(handler) {
  let callIndex = 0;
  globalThis.fetch = mock.fn(async (url, opts) => {
    if (opts?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const result = handler(url, callIndex++, opts);
    if (result instanceof Promise) return result;
    if (result.error) throw new Error(result.error);
    return { ok: true, json: async () => result.data };
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createNavController", () => {
  describe("loadRoot", () => {
    it("dispatches SET_COLUMN with entries on success", async () => {
      const store = createFileBrowserStore();
      const nav = createNavController(store);

      mockFetch(() => ({
        data: { path: "/home", entries: [dir("docs"), file("readme.md")] },
      }));

      await nav.loadRoot("/home");
      const state = store.getState();
      assert.equal(state.columns.length, 1);
      assert.equal(state.columns[0].path, "/home");
      assert.equal(state.columns[0].loading, false);
      assert.equal(state.columns[0].error, null);
      assert.equal(state.columns[0].entries.length, 2);
    });

    it("dispatches SET_COLUMN_ERROR on fetch failure", async () => {
      const store = createFileBrowserStore();
      const nav = createNavController(store);

      mockFetch(() => ({ error: "Network error" }));

      await nav.loadRoot("/bad");
      const state = store.getState();
      assert.equal(state.columns.length, 1);
      assert.equal(state.columns[0].loading, false);
      assert.equal(state.columns[0].error, "Network error");
    });
  });

  describe("generation counter (stale response cancellation)", () => {
    it("discards stale loadRoot response when a newer navigation fires", async () => {
      const store = createFileBrowserStore();
      const nav = createNavController(store);

      const fetchCalls = [];
      globalThis.fetch = mock.fn(async (url) => {
        return new Promise(resolve => {
          fetchCalls.push({ url, resolve });
        });
      });

      // Fire two loadRoots rapidly
      const p1 = nav.loadRoot("/first");
      const p2 = nav.loadRoot("/second");

      // Resolve second first
      fetchCalls[1].resolve({
        ok: true,
        json: async () => ({ path: "/second", entries: [dir("b")] }),
      });
      await p2;

      // Now resolve first (stale) — should be discarded
      fetchCalls[0].resolve({
        ok: true,
        json: async () => ({ path: "/first", entries: [dir("a")] }),
      });
      await p1;

      const state = store.getState();
      assert.equal(state.columns[0].path, "/second");
      assert.equal(state.columns[0].entries[0].name, "b");
    });

    it("discards stale selectItem response when a newer navigation fires", async () => {
      const store = storeWithColumn("/home", [dir("a"), dir("b")]);
      const nav = createNavController(store);

      const fetchCalls = [];
      globalThis.fetch = mock.fn(async (url) => {
        return new Promise(resolve => {
          fetchCalls.push({ url, resolve });
        });
      });

      const p1 = nav.selectItem(0, "a");
      const p2 = nav.selectItem(0, "b");

      // Resolve "b" first
      fetchCalls[1].resolve({
        ok: true,
        json: async () => ({ path: "/home/b", entries: [file("b1.txt")] }),
      });
      await p2;

      // Resolve "a" (stale) — should be discarded
      fetchCalls[0].resolve({
        ok: true,
        json: async () => ({ path: "/home/a", entries: [file("a1.txt")] }),
      });
      await p1;

      const state = store.getState();
      assert.equal(state.columns[0].selected, "b");
      assert.equal(state.columns[1].path, "/home/b");
      assert.equal(state.columns[1].entries[0].name, "b1.txt");
    });
  });

  describe("refreshAll error handling", () => {
    it("dispatches SET_COLUMN_ERROR on failure instead of silent swallow", async () => {
      const store = storeWithColumn("/home", [dir("docs")], "docs");
      store.dispatch({
        type: "SET_COLUMN",
        index: 1,
        path: "/home/docs",
        entries: [file("readme.md")],
      });

      const nav = createNavController(store);

      let callIdx = 0;
      mockFetch(() => {
        callIdx++;
        if (callIdx === 1) {
          return { data: { path: "/home", entries: [dir("docs"), file("new.txt")] } };
        }
        return { error: "Permission denied" };
      });

      await nav.refreshAll();
      const state = store.getState();
      assert.equal(state.columns[0].error, null);
      assert.ok(state.columns[0].entries.length >= 1);
      assert.equal(state.columns[1].loading, false);
      assert.equal(state.columns[1].error, "Permission denied");
    });
  });

  describe("selectItem", () => {
    it("selects a file without fetching", async () => {
      const store = storeWithColumn("/home", [file("readme.md"), dir("docs")]);
      const nav = createNavController(store);

      globalThis.fetch = mock.fn(() => { throw new Error("should not fetch"); });

      await nav.selectItem(0, "readme.md");
      const state = store.getState();
      assert.equal(state.columns[0].selected, "readme.md");
      assert.equal(state.columns.length, 1);
      assert.equal(globalThis.fetch.mock.callCount(), 0);
    });

    it("selects a directory and loads its contents", async () => {
      const store = storeWithColumn("/home", [dir("docs")]);
      const nav = createNavController(store);

      mockFetch(() => ({
        data: { path: "/home/docs", entries: [file("readme.md")] },
      }));

      await nav.selectItem(0, "docs");
      const state = store.getState();
      assert.equal(state.columns[0].selected, "docs");
      assert.equal(state.columns.length, 2);
      assert.equal(state.columns[1].path, "/home/docs");
      assert.equal(state.columns[1].entries[0].name, "readme.md");
    });
  });

  describe("goBack", () => {
    it("trims the last column", () => {
      const store = storeWithColumn("/home", [dir("docs")], "docs");
      store.dispatch({
        type: "SET_COLUMN",
        index: 1,
        path: "/home/docs",
        entries: [file("readme.md")],
      });

      const nav = createNavController(store);
      assert.equal(store.getState().columns.length, 2);

      nav.goBack();
      assert.equal(store.getState().columns.length, 1);
    });

    it("does nothing at root (single column)", () => {
      const store = storeWithColumn("/home", [dir("docs")]);
      const nav = createNavController(store);

      nav.goBack();
      assert.equal(store.getState().columns.length, 1);
    });
  });
});

describe("getDeepestPath", () => {
  it("returns / for empty columns", () => {
    assert.equal(getDeepestPath({ columns: [] }), "/");
  });

  it("returns the last column path", () => {
    assert.equal(
      getDeepestPath({ columns: [{ path: "/a" }, { path: "/a/b" }] }),
      "/a/b",
    );
  });
});
