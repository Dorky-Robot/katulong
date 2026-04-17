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
    this.parentNode = null;
  }
  appendChild(child) {
    // Match DOM semantics: appending a node that already has a parent
    // detaches it from the old parent first.
    if (child.parentNode && child.parentNode !== this) {
      const idx = child.parentNode.children.indexOf(child);
      if (idx >= 0) child.parentNode.children.splice(idx, 1);
    } else if (child.parentNode === this) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  querySelector(sel) {
    // Simple class- or tag-based search
    const pred = sel.startsWith(".")
      ? (c) => c.className?.includes?.(sel.slice(1))
      : (c) => c.tagName === sel.toUpperCase();
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
  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }
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

// Stub global window — the feed tile attaches `katulong:topic-new`
// listeners to catch new-topic broadcasts for the picker.
const winListeners = {};
globalThis.window = {
  addEventListener(evt, fn) { (winListeners[evt] ||= []).push(fn); },
  removeEventListener(evt, fn) {
    const arr = winListeners[evt];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  dispatchEvent(evt) {
    const arr = winListeners[evt.type] || [];
    for (const fn of [...arr]) fn(evt);
  },
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

const { feedRenderer } = await import(
  new URL("../public/lib/tile-renderers/feed.js", import.meta.url).href
);

describe("feedRenderer", () => {
  beforeEach(() => {
    eventSources.length = 0;
    fetchResult = [];
    for (const k of Object.keys(winListeners)) delete winListeners[k];
  });

  describe("structure", () => {
    it("has type 'feed'", () => {
      assert.equal(feedRenderer.type, "feed");
    });

    it("init accepts no args", () => {
      feedRenderer.init();
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

    it("is persistable", () => {
      assert.equal(feedRenderer.describe({}).persistable, true);
      assert.equal(feedRenderer.describe({ topic: "some/topic" }).persistable, true);
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

      assert.equal(el.children.length, 1);
      const root = el.children[0];
      assert.equal(root.className, "feed-tile-root");

      assert.ok(root.children.length >= 1, "picker should be in root");
      const picker = root.children[0];
      assert.equal(picker.className, "feed-tile-picker");

      assert.ok(picker.children.length >= 1);
      const titleEl = picker.children[0];
      assert.equal(titleEl.className, "feed-tile-picker-title");
      assert.equal(titleEl.children[0].textContent, "Subscribe to a topic");

      const listArea = picker.children[1];
      assert.equal(listArea.className, "feed-tile-picker-list");
      assert.equal(listArea.textContent, "Loading topics\u2026");
    });

    it("does not open an EventSource when no topic", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, { id: "feed-1", props: {}, dispatch: () => {}, ctx: {} });

      assert.equal(eventSources.length, 0);
    });
  });

  describe("mount() — streaming", () => {
    it("opens EventSource at /sub/ for generic topics", () => {
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

    it("opens EventSource at /api/claude/stream/:uuid for claude/<uuid>", () => {
      // Claude topics route to the narration-aware endpoint, which refcounts
      // a per-UUID processor for the life of the connection.
      const uuid = "11111111-2222-3333-4444-555555555555";
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: `claude/${uuid}`, meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(eventSources.length, 1);
      assert.ok(
        eventSources[0].url.includes(`/api/claude/stream/${uuid}`),
        `expected /api/claude/stream/${uuid} in ${eventSources[0].url}`,
      );
      assert.ok(eventSources[0].url.includes("fromSeq=0"));
    });

    it("falls back to /sub/ when a claude/<nonuuid> topic sneaks in", () => {
      // Defense-in-depth: only well-formed UUIDs get the narration route.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/not-a-uuid", meta: {} },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(eventSources.length, 1);
      assert.ok(eventSources[0].url.includes("/sub/claude%2Fnot-a-uuid"));
    });

    it("renders header with back button, topic name, and close button", () => {
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
      // [backBtn, title, closeBtn]
      assert.equal(header.children.length, 3);
      assert.equal(header.children[0].className, "feed-tile-back-btn");
      assert.equal(header.children[1].textContent, "my/topic");
      assert.equal(header.children[2].className, "feed-tile-close-btn");
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

      es.onmessage({
        data: JSON.stringify({
          seq: 1,
          topic: "t",
          message: '{"text":"hello"}',
          timestamp: Date.now(),
        }),
      });

      const root = el.children[0];
      const list = root.children[1]; // header is [0], list is [1]
      assert.equal(list.children.length, 1);
    });

    it("renders reply events as collapsible <details> rows with word-count fallback", () => {
      // The processor publishes one `reply` event per assistant entry from
      // the transcript. Collapsed summary shows `Claude's reply (N words)`
      // until Ollama (optionally) enriches it with a one-liner title.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1,
          topic: "claude/abc",
          message: JSON.stringify({
            status: "reply",
            entryId: "entry-1",
            step: "All tests pass.",
            ts: 1_700_000_000_000,
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 1);
      const row = list.children[0];
      assert.equal(row.tagName, "DETAILS");
      assert.ok(
        row.className.includes("feed-status-reply"),
        `expected feed-status-reply, got: ${row.className}`,
      );
      const summary = row.children[0];
      assert.equal(summary.tagName, "SUMMARY");
      const timeSpan = summary.children[0];
      const labelSpan = summary.children[1];
      assert.equal(timeSpan.className, "feed-tile-row-time");
      assert.ok(timeSpan.textContent, "time span renders a formatted timestamp");
      assert.equal(labelSpan.textContent, "Claude's reply (3 words)");
      assert.equal(row.children[1].className, "feed-tile-reply-body");
      assert.equal(row.children[1].textContent, "All tests pass.");
    });

    it("applies a reply-title enrichment to the matching entryId", () => {
      // Progressive enhancement: the reply card renders immediately with
      // the word-count fallback; when Ollama finishes, a `reply-title`
      // event swaps the label in place.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify({
            status: "reply", entryId: "entry-x",
            step: "Reading the auth module.",
            ts: 1_700_000_000_000,
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 2, topic: "claude/abc",
          message: JSON.stringify({
            status: "reply-title", entryId: "entry-x",
            title: "Reading the auth module",
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      const list = el.children[0].children[1];
      const row = list.children[0];
      const label = row.children[0].children[1];
      assert.equal(label.textContent, "Reading the auth module");
    });

    it("buffers a reply-title that arrives before its reply (defensive)", () => {
      // Within a single topic the processor publishes reply first, but
      // across reconnects / replays the SSE replay order can't be fully
      // trusted. If the title shows up first, hold it and apply when the
      // reply appears — no broken state, no dropped enrichment.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify({
            status: "reply-title", entryId: "entry-y", title: "Early title",
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 2, topic: "claude/abc",
          message: JSON.stringify({
            status: "reply", entryId: "entry-y",
            step: "Hello.", ts: 1_700_000_000_000,
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      const list = el.children[0].children[1];
      const label = list.children[0].children[0].children[1];
      assert.equal(label.textContent, "Early title");
    });

    it("silently drops legacy narrative / completion / summary events", () => {
      // Old topic logs (from the pre-rewire narrator) still contain these
      // event types. New renderers ignore them rather than crashing or
      // rendering raw JSON.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      for (const [i, legacy] of [
        { step: "old narrative", status: "narrative" },
        { step: "old objective", status: "summary" },
        { step: "old completion", status: "completion" },
        { step: "old attention", status: "attention" },
      ].entries()) {
        eventSources[0].onmessage({
          data: JSON.stringify({
            seq: i + 1, topic: "claude/abc",
            message: JSON.stringify(legacy),
            timestamp: Date.now(),
          }),
        });
      }

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 0);
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
