import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// feed.js uses DOM APIs — provide minimal stubs so the module loads in Node.
// We only need enough to verify the renderer's structure and mount lifecycle.

class FakeElement {
  constructor(tag) {
    this.tagName = tag?.toUpperCase() || "DIV";
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.dataset = {};
    this.tabIndex = -1;
    this._listeners = {};
    this.style = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.innerHTML = "";
    this.scrollHeight = 0;
    this.scrollTop = 0;
  }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(sel) {
    // Simple class-based search
    for (const c of this.children) {
      if (sel.startsWith(".") && c.className.includes(sel.slice(1))) return c;
      const found = c.querySelector?.(sel);
      if (found) return found;
    }
    return null;
  }
  addEventListener(evt, fn) {
    (this._listeners[evt] ||= []).push(fn);
  }
  remove() {}
}

// Stub global document for feed.js
globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
};

// Stub global EventSource — track what URLs are opened
const eventSources = [];
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.closed = false;
    eventSources.push(this);
  }
  close() { this.closed = true; }
}
globalThis.EventSource = FakeEventSource;

// Stub global fetch
let fetchResult = [];
globalThis.fetch = async (url, opts) => ({
  ok: true,
  json: async () => fetchResult,
});

const { feedRenderer } = await import(
  new URL("../public/lib/tile-renderers/feed.js", import.meta.url).href
);

describe("feedRenderer", () => {
  beforeEach(() => {
    eventSources.length = 0;
    fetchResult = [];
  });

  describe("structure", () => {
    it("has type 'feed'", () => {
      assert.equal(feedRenderer.type, "feed");
    });

    it("init accepts empty deps", () => {
      // Should not throw
      feedRenderer.init({});
    });
  });

  describe("describe()", () => {
    it("returns default title and icon when no props", () => {
      const d = feedRenderer.describe({});
      assert.equal(d.title, "Feed");
      assert.equal(d.icon, "rss");
    });

    it("uses topic as title when provided", () => {
      const d = feedRenderer.describe({ topic: "_build/test" });
      assert.equal(d.title, "_build/test");
    });

    it("uses explicit title over topic", () => {
      const d = feedRenderer.describe({ topic: "x", title: "My Feed" });
      assert.equal(d.title, "My Feed");
    });

    it("is not persistable without a topic", () => {
      const d = feedRenderer.describe({});
      assert.equal(d.persistable, false);
    });

    it("is persistable with a topic", () => {
      const d = feedRenderer.describe({ topic: "some/topic" });
      assert.equal(d.persistable, true);
    });
  });

  describe("mount() — topic picker", () => {
    it("shows topic picker when no topic in props", async () => {
      const el = new FakeElement("div");
      const dispatched = [];

      feedRenderer.mount(el, {
        id: "feed-1",
        props: {},
        dispatch: (action) => dispatched.push(action),
        ctx: {},
      });

      // Root element should be appended
      assert.equal(el.children.length, 1);
      const root = el.children[0];
      assert.equal(root.className, "feed-tile-root");

      // Picker should be appended synchronously
      assert.ok(root.children.length >= 1, "picker should be in root");
      const picker = root.children[0];
      assert.equal(picker.className, "feed-tile-picker");

      // Title should say "Subscribe to a topic"
      assert.ok(picker.children.length >= 1);
      const titleEl = picker.children[0];
      assert.equal(titleEl.className, "feed-tile-picker-title");
      assert.equal(titleEl.children[0].textContent, "Subscribe to a topic");

      // List area with loading text
      const listArea = picker.children[1];
      assert.equal(listArea.className, "feed-tile-picker-list");
      assert.equal(listArea.textContent, "Loading topics\u2026");
    });

    it("does not open an EventSource when no topic", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, { id: "feed-1", props: {}, dispatch: () => {}, ctx: {} });

      // No EventSource should have been created
      assert.equal(eventSources.length, 0);
    });
  });

  describe("mount() — streaming", () => {
    it("opens EventSource immediately when topic is in props", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "_build/test", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(eventSources.length, 1);
      assert.ok(eventSources[0].url.includes("/sub/_build%2Ftest"));
      assert.ok(eventSources[0].url.includes("fromSeq=0"));
    });

    it("renders header with topic name", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "my/topic", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      const root = el.children[0];
      const header = root.children[0];
      assert.equal(header.className, "feed-tile-header");
      assert.equal(header.children[0].textContent, "my/topic");
    });

    it("renders badge when meta.type is set", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const root = el.children[0];
      const header = root.children[0];
      // Second child should be the badge
      assert.equal(header.children.length, 2);
      assert.equal(header.children[1].className, "feed-tile-badge");
      assert.equal(header.children[1].textContent, "progress");
    });

    it("does not render badge when no meta.type", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      const root = el.children[0];
      const header = root.children[0];
      assert.equal(header.children.length, 1); // just the title span
    });

    it("processes SSE events via onmessage", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      const es = eventSources[0];

      // Simulate an SSE event
      es.onmessage({
        data: JSON.stringify({
          seq: 1,
          topic: "t",
          message: '{"text":"hello"}',
          timestamp: Date.now(),
        }),
      });

      // List should have one item
      const root = el.children[0];
      const list = root.children[1]; // header is [0], list is [1]
      assert.equal(list.children.length, 1);
    });
  });

  describe("unmount", () => {
    it("closes EventSource on unmount", () => {
      const el = new FakeElement("div");
      const handle = feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(eventSources[0].closed, false);
      handle.unmount();
      assert.equal(eventSources[0].closed, true);
    });

    it("clears element on unmount", () => {
      const el = new FakeElement("div");
      const handle = feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      handle.unmount();
      assert.equal(el.innerHTML, "");
    });

    it("ignores SSE events after unmount", () => {
      const el = new FakeElement("div");
      const handle = feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      const es = eventSources[0];
      handle.unmount();

      // Should not throw
      es.onmessage({
        data: JSON.stringify({
          seq: 1, topic: "t", message: '{"text":"late"}', timestamp: Date.now(),
        }),
      });
    });
  });

  describe("handle interface", () => {
    it("returns all required handle methods", () => {
      const el = new FakeElement("div");
      const handle = feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(typeof handle.unmount, "function");
      assert.equal(typeof handle.focus, "function");
      assert.equal(typeof handle.blur, "function");
      assert.equal(typeof handle.resize, "function");
      assert.equal(typeof handle.getSessions, "function");
      assert.deepEqual(handle.getSessions(), []);
      assert.equal(handle.tile, null);
    });
  });
});
