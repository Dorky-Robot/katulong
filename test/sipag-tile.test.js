/**
 * sipag-tile: unit tests
 *
 * Asserts the tile's public contract:
 *   - describe() shape
 *   - mount() resolves URL via per-tile prop > /api/config > fallback
 *   - mount→unmount race: a late-arriving config fetch after unmount
 *     does NOT append an iframe (the renderer's `mounted` guard).
 *
 * Uses mock.module to stub `/lib/api-client.js` so we drive `api.get`
 * directly without spinning up fetch / network.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

if (typeof mock.module !== "function") {
  describe("sipag-tile", () => {
    it("skipped: mock.module not available in this Node version", () => {});
  });
  process.exit(0);
}

// ── DOM stubs (minimal — sipag.js uses createElement, appendChild,
// setAttribute, addEventListener, querySelector for the toolbar refs).
class FakeElement {
  constructor(tag) {
    this.tagName = tag?.toUpperCase() || "DIV";
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.src = "";
    this._innerHTML = "";
    this._listeners = {};
    this.attributes = {};
    this.parentNode = null;
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "" || v == null) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
    }
  }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  querySelector(sel) {
    // Support `.class` and `[attr="val"]`.
    const classMatch = sel.startsWith(".");
    const attrMatch = sel.match(/^\[([^=]+)="([^"]+)"\]$/);
    const pred = (c) => {
      if (classMatch) return c.className?.includes?.(sel.slice(1));
      if (attrMatch) return c.attributes?.[attrMatch[1]] === attrMatch[2];
      return c.tagName === sel.toUpperCase();
    };
    for (const c of this.children) {
      if (pred(c)) return c;
      const found = c.querySelector?.(sel);
      if (found) return found;
    }
    return null;
  }
  addEventListener(evt, fn) {
    (this._listeners[evt] ||= []).push(fn);
  }
}

globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
  querySelector() { return null; },
};
globalThis.window = { open() {} };

// ── Stub /lib/api-client.js. Each test sets `apiGetImpl`.
const apiClientUrl = new URL(
  "../public/lib/api-client.js",
  import.meta.url,
).href;

let apiGetImpl = async () => { throw new Error("apiGetImpl not set"); };
mock.module(apiClientUrl, {
  namedExports: {
    api: { get: (...args) => apiGetImpl(...args) },
  },
});

const { sipagRenderer } = await import(
  new URL("../public/lib/tile-renderers/sipag.js", import.meta.url).href
);

function makeMountArgs(propsUrl = null) {
  return {
    el: new FakeElement("div"),
    api: {
      id: "sipag-test",
      props: propsUrl ? { url: propsUrl } : {},
      dispatch: () => {},
      ctx: {},
    },
  };
}

describe("sipagRenderer.describe", () => {
  it("returns title, icon, persistable", () => {
    const d = sipagRenderer.describe({});
    assert.equal(d.title, "sipag");
    assert.equal(d.icon, "list-checks");
    assert.equal(d.persistable, true);
    assert.equal(d.session, null);
  });
});

describe("sipagRenderer.mount", () => {
  beforeEach(() => {
    apiGetImpl = async () => { throw new Error("apiGetImpl not set"); };
  });

  it("uses props.url verbatim and skips the config fetch", () => {
    let fetched = false;
    apiGetImpl = async () => { fetched = true; return { config: {} }; };
    const { el, api } = makeMountArgs("https://override.example/foo");
    const handle = sipagRenderer.mount(el, api);
    const iframe = el.querySelector("IFRAME");
    assert.ok(iframe, "iframe element created synchronously");
    assert.equal(iframe.src, "https://override.example/foo");
    assert.equal(fetched, false, "config fetch was skipped");
    handle.unmount();
  });

  it("reads config.sipagUrl when no per-tile prop", async () => {
    apiGetImpl = async () => ({ config: { sipagUrl: "https://from-config.example/" } });
    const { el, api } = makeMountArgs();
    const handle = sipagRenderer.mount(el, api);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const iframe = el.querySelector("IFRAME");
    assert.ok(iframe, "iframe mounted after config resolves");
    assert.equal(iframe.src, "https://from-config.example/");
    handle.unmount();
  });

  it("falls back to /_proxy/7100/ when config has no sipagUrl", async () => {
    apiGetImpl = async () => ({ config: {} });
    const { el, api } = makeMountArgs();
    const handle = sipagRenderer.mount(el, api);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const iframe = el.querySelector("IFRAME");
    assert.equal(iframe.src, "/_proxy/7100/");
    handle.unmount();
  });

  it("falls back to /_proxy/7100/ when config fetch rejects", async () => {
    apiGetImpl = async () => { throw new Error("network down"); };
    const { el, api } = makeMountArgs();
    const handle = sipagRenderer.mount(el, api);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const iframe = el.querySelector("IFRAME");
    assert.ok(iframe, "iframe mounted after fetch error");
    assert.equal(iframe.src, "/_proxy/7100/");
    handle.unmount();
  });

  it("does NOT mount an iframe if unmounted before fetch resolves", async () => {
    let release;
    apiGetImpl = () => new Promise((r) => { release = r; });
    const { el, api } = makeMountArgs();
    const handle = sipagRenderer.mount(el, api);
    handle.unmount();
    release({ config: { sipagUrl: "https://late.example/" } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // unmount() clears el.innerHTML — children must remain empty even
    // after the late `.then()` ran on the resolved fetch.
    assert.equal(el.children.length, 0, "no late iframe append after unmount");
  });

  it("sets the iframe sandbox with allow-top-navigation-by-user-activation", () => {
    const { el, api } = makeMountArgs("https://x.example/");
    const handle = sipagRenderer.mount(el, api);
    const iframe = el.querySelector("IFRAME");
    const sandbox = iframe.attributes["sandbox"];
    assert.match(sandbox, /allow-top-navigation-by-user-activation/);
    assert.match(sandbox, /allow-same-origin/);
    assert.match(sandbox, /allow-scripts/);
    handle.unmount();
  });
});
