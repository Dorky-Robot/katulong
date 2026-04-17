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

    it("renders completion events as collapsible <details> rows", () => {
      // Stop hooks emit `status: "completion"` cards — the user already saw
      // this reply in the terminal, so we render it as a <details> with a
      // concise summary. The body stays one click away without crowding
      // the narrative. Must NOT fold into the muted details-group.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const es = eventSources[0];
      es.onmessage({
        data: JSON.stringify({
          seq: 1,
          topic: "claude/abc",
          message: JSON.stringify({
            step: "All tests pass.",
            status: "completion",
            event: "Completion",
          }),
          timestamp: Date.now(),
        }),
      });

      const root = el.children[0];
      const list = root.children[1];

      // list now has [reply row, working card]
      assert.ok(list.children.length >= 1);
      const row = list.children[0];
      assert.equal(row.tagName, "DETAILS");
      assert.ok(
        row.className.includes("feed-status-reply"),
        `expected feed-status-reply, got: ${row.className}`,
      );
      assert.equal(row.children[0].tagName, "SUMMARY");
      assert.equal(row.children[0].className, "feed-tile-reply-summary");
      assert.equal(row.children[0].textContent, "Claude's reply (3 words)");
      assert.equal(row.children[1].className, "feed-tile-reply-body");
      assert.equal(row.children[1].textContent, "All tests pass.");
      assert.equal(list.querySelector(".feed-tile-details-group"), null);
    });

    it("renders question-form attention as a collapsible reply", () => {
      // Stop-hook replies ending in '?' are emitted as status: attention
      // (Claude is waiting for the user). The text itself is still just
      // the reply the user saw in the terminal, so collapse it like a
      // completion. Tool-approval attention (tool != null) stays prominent.
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
            step: "Hi! What would you like to work on?",
            status: "attention", event: "Attention", tool: null,
          }),
          timestamp: Date.now(),
        }),
      });

      const list = el.children[0].children[1];
      const row = list.children[0];
      assert.equal(row.tagName, "DETAILS");
      assert.ok(row.className.includes("feed-status-reply"));
      // Summary hints at waiting-for-input since the message was a question.
      assert.ok(
        row.children[0].textContent.includes("waiting for you"),
        `expected waiting-for-you hint, got: ${row.children[0].textContent}`,
      );
    });

    it("keeps tool-approval attention prominent (not collapsed)", () => {
      // PreToolUse events carry a tool name and are actionable — render as
      // a normal attention card with high-contrast warning color, not a
      // hidden details body.
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
            step: "Approve Bash: ls?", status: "attention",
            event: "Attention", tool: "Bash",
          }),
          timestamp: Date.now(),
        }),
      });

      const row = el.children[0].children[1].children[0];
      assert.equal(row.tagName, "DIV");
      assert.ok(row.className.includes("feed-status-attention"));
      assert.equal(row.children[0].className, "feed-tile-attention");
    });

    it("shows a working card below the completion row", () => {
      // The working card gives visual feedback while Ollama processes the
      // narrative — a rotating goofy gerund so the feed doesn't look frozen.
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
          message: JSON.stringify({ step: "done", status: "completion" }),
          timestamp: Date.now(),
        }),
      });

      const list = el.children[0].children[1];
      const card = list.querySelector(".feed-tile-working-card");
      assert.ok(card, "expected a working card after completion");
      assert.ok(card.querySelector(".feed-tile-working-dot"));
      assert.ok(card.querySelector(".feed-tile-working-phrase"));
    });

    it("hides the working card once a narrative arrives", () => {
      // The narrative supersedes the placeholder — card must disappear so
      // the user doesn't think another thing is still in flight.
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
          message: JSON.stringify({ step: "done", status: "completion" }),
          timestamp: Date.now(),
        }),
      });
      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 2, topic: "claude/abc",
          message: JSON.stringify({ step: "Claude tidied up the tests.", status: "narrative" }),
          timestamp: Date.now(),
        }),
      });

      const list = el.children[0].children[1];
      assert.equal(list.querySelector(".feed-tile-working-card"), null);
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
