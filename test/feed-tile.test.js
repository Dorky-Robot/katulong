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

// Stub global window — the feed tile attaches `katulong:topic-new`
// listeners to catch new-topic broadcasts.
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

    it("is persistable for normal props", () => {
      assert.equal(feedRenderer.describe({}).persistable, true);
      assert.equal(feedRenderer.describe({ topic: "some/topic" }).persistable, true);
    });

    it("is NOT persistable while awaiting Claude (transient state)", () => {
      // Persisting a waiter with baseline { uuid: null, startedAt: 0 } would
      // swap to any lingering claude/<uuid> on reload. Dropping the tile
      // instead keeps restores clean.
      assert.equal(
        feedRenderer.describe({ awaitingClaudeForSession: "work" }).persistable,
        false,
      );
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
      assert.equal(header.children[0].className, "feed-tile-back-btn");
      assert.equal(header.children[1].textContent, "my/topic");
      assert.equal(header.children[2].className, "feed-tile-close-btn");
    });

    it("header has back button, title, and close button", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "t", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const root = el.children[0];
      const header = root.children[0];
      // [backBtn, title, closeBtn]
      assert.equal(header.children.length, 3);
      assert.equal(header.children[0].className, "feed-tile-back-btn");
      assert.equal(header.children[1].textContent, "t");
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

  // ── Awaiting-Claude state ──────────────────────────────────────────
  //
  // When the user clicks the Claude sparkle before the SessionStart hook
  // has published a fresh uuid, the feed tile mounts in an awaiting state.
  // It must subscribe to the session store and transition into a normal
  // streaming view as soon as a fresh uuid appears.

  describe("mount() — awaiting Claude", () => {
    // Minimal fake session store — enough for the tile to read state and
    // register a subscriber. Tests mutate `state.sessions[*].meta.claude`
    // and call `emit()` to simulate a server-pushed session-updated.
    function makeFakeSessionStore(sessions) {
      const state = { sessions };
      const subs = [];
      return {
        _state: state,
        _subs: subs,
        getState() { return state; },
        subscribe(fn) {
          subs.push(fn);
          return () => {
            const i = subs.indexOf(fn);
            if (i >= 0) subs.splice(i, 1);
          };
        },
        emit() { for (const fn of [...subs]) fn(state); },
      };
    }

    it("renders blank stream header and list without opening EventSource", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      // No EventSource — nothing to subscribe to yet.
      assert.equal(eventSources.length, 0);

      const root = el.children[0];
      assert.equal(root.className, "feed-tile-root");

      // Header [back, title, close] + empty list.
      const header = root.children[0];
      assert.equal(header.className, "feed-tile-header");
      assert.equal(header.children.length, 3);
      assert.equal(header.children[1].textContent, "Claude");

      const list = root.children[1];
      assert.equal(list.className, "feed-tile-list");
      assert.equal(list.children.length, 0);
    });

    it("registers a subscriber on the session store", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(store._subs.length, 1);
    });

    it("transitions to streaming when a fresh uuid lands", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      const dispatched = [];
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: (a) => dispatched.push(a),
        ctx: {},
      });

      assert.equal(eventSources.length, 0);

      // Simulate SessionStart hook populating the uuid server-side, then
      // the session-updated push reaching the client.
      store._state.sessions[0].meta.claude = {
        running: true,
        detectedAt: 1,
        uuid: "11111111-2222-3333-4444-555555555555",
        startedAt: 2,
      };
      store.emit();

      assert.equal(eventSources.length, 1, "streaming EventSource should open");
      assert.ok(eventSources[0].url.includes("/sub/claude%2F11111111-2222-3333-4444-555555555555"));

      // Persistence: UPDATE_PROPS dispatched so the tile restores as a
      // normal streaming tile after a reload.
      const patchAction = dispatched.find(a => a.type === "ui/UPDATE_PROPS");
      assert.ok(patchAction, "UPDATE_PROPS should be dispatched");
      assert.equal(patchAction.patch.topic, "claude/11111111-2222-3333-4444-555555555555");
      assert.equal(patchAction.patch.awaitingClaudeForSession, null);
    });

    it("swaps immediately when the uuid is already fresh at mount", () => {
      const store = makeFakeSessionStore([
        {
          name: "work",
          meta: { claude: {
            running: true, detectedAt: 1,
            uuid: "11111111-2222-3333-4444-555555555555",
            startedAt: 2,
          } },
        },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      // Synchronous swap — no subscriber tick required.
      assert.equal(eventSources.length, 1);
    });

    it("does NOT swap when the stored uuid matches the baseline (stale)", () => {
      const uuid = "11111111-2222-3333-4444-555555555555";
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true, uuid, startedAt: 100 } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          // Click-time baseline: we already saw this uuid before opening.
          awaitingBaseline: { uuid, startedAt: 100 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(eventSources.length, 0);

      // A store emit with the same meta should be a no-op.
      store.emit();
      assert.equal(eventSources.length, 0);
    });

    it("swaps when the uuid itself changes (new Claude session)", () => {
      const oldUuid = "11111111-1111-1111-1111-111111111111";
      const newUuid = "22222222-2222-2222-2222-222222222222";
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true, uuid: oldUuid, startedAt: 100 } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: oldUuid, startedAt: 100 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      store._state.sessions[0].meta.claude = {
        running: true, uuid: newUuid, startedAt: 200,
      };
      store.emit();

      assert.equal(eventSources.length, 1);
      assert.ok(eventSources[0].url.includes(encodeURIComponent(`claude/${newUuid}`)));
    });

    it("swaps when startedAt advances even if uuid is unchanged", () => {
      // This catches the hook-restart case where Claude kept the same
      // session_id but the server re-wrote startedAt after a flap.
      const uuid = "11111111-2222-3333-4444-555555555555";
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true, uuid, startedAt: 100 } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid, startedAt: 100 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      store._state.sessions[0].meta.claude = {
        running: true, uuid, startedAt: 200,
      };
      store.emit();

      assert.equal(eventSources.length, 1);
    });

    it("swaps when a katulong:topic-new claude/<uuid> event arrives", () => {
      // Fallback path: session store never surfaces meta.claude.uuid
      // (e.g. staging doesn't receive hook events), but the topic itself
      // gets broadcast via the pub/sub bridge. The awaiting view must
      // still swap so the user sees live events.
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      const dispatched = [];
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: (a) => dispatched.push(a),
        ctx: {},
      });

      assert.equal(eventSources.length, 0);

      const uuid = "33333333-3333-3333-3333-333333333333";
      globalThis.window.dispatchEvent(new globalThis.CustomEvent("katulong:topic-new", {
        detail: { topic: `claude/${uuid}`, meta: { type: "progress" } },
      }));

      assert.equal(eventSources.length, 1, "streaming should open on topic-new");
      assert.ok(eventSources[0].url.includes(encodeURIComponent(`claude/${uuid}`)));

      const patch = dispatched.find(a => a.type === "ui/UPDATE_PROPS");
      assert.ok(patch);
      assert.equal(patch.patch.topic, `claude/${uuid}`);
      assert.equal(patch.patch.awaitingClaudeForSession, null);
    });

    it("ignores non-claude topic-new events while awaiting", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      globalThis.window.dispatchEvent(new globalThis.CustomEvent("katulong:topic-new", {
        detail: { topic: "build/something", meta: {} },
      }));

      assert.equal(eventSources.length, 0);
    });

    it("ignores claude/<uuid> that matches baseline uuid (stale)", () => {
      const uuid = "44444444-4444-4444-4444-444444444444";
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid, startedAt: 100 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      globalThis.window.dispatchEvent(new globalThis.CustomEvent("katulong:topic-new", {
        detail: { topic: `claude/${uuid}`, meta: {} },
      }));

      assert.equal(eventSources.length, 0);
    });

    it("drops the awaiting topic-new listener when back → picker transitions view", () => {
      // Regression: the tile used to register listeners into a flat
      // cleanups[] array drained only on unmount, so clicking "back" from
      // the awaiting view into the picker left the awaiting-mode
      // onTopicNew live. A subsequent claude/<uuid> broadcast would then
      // silently hijack the tile into streaming mode while the user was
      // browsing the picker. View-local cleanups drain on transition.
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      // Awaiting view is up — one topic-new listener.
      assert.equal((winListeners["katulong:topic-new"] || []).length, 1);

      // Simulate "back" button click — calls showTopicPicker internally.
      const root = el.children[0];
      const headerBackBtn = root.children[0].children[0];
      assert.equal(headerBackBtn.className, "feed-tile-back-btn");
      const clickHandlers = headerBackBtn._listeners.click || [];
      assert.equal(clickHandlers.length, 1);
      clickHandlers[0]();

      // Picker has exactly one topic-new listener — the awaiting one was
      // drained, not accumulated.
      assert.equal((winListeners["katulong:topic-new"] || []).length, 1);

      // Prove the drained listener is actually gone: dispatching a
      // claude/<uuid> topic-new must NOT pivot the picker to streaming.
      const uuid = "55555555-5555-5555-5555-555555555555";
      globalThis.window.dispatchEvent(new globalThis.CustomEvent("katulong:topic-new", {
        detail: { topic: `claude/${uuid}`, meta: {} },
      }));
      assert.equal(eventSources.length, 0, "picker must not auto-swap to stream");
    });

    it("rejects topic-new payloads whose uuid is not a valid UUID", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      globalThis.window.dispatchEvent(new globalThis.CustomEvent("katulong:topic-new", {
        detail: { topic: "claude/../etc/passwd", meta: {} },
      }));
      globalThis.window.dispatchEvent(new globalThis.CustomEvent("katulong:topic-new", {
        detail: { topic: "claude/not-a-uuid", meta: {} },
      }));

      assert.equal(eventSources.length, 0);
    });

    it("removes the topic-new listener on unmount", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      const handle = feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal((winListeners["katulong:topic-new"] || []).length, 1);
      handle.unmount();
      assert.equal((winListeners["katulong:topic-new"] || []).length, 0);
    });

    it("unsubscribes from the store on unmount", () => {
      const store = makeFakeSessionStore([
        { name: "work", meta: { claude: { running: true } } },
      ]);
      feedRenderer.init({ getSessionStore: () => store });

      const el = new FakeElement("div");
      const handle = feedRenderer.mount(el, {
        id: "feed-1",
        props: {
          topic: null,
          awaitingClaudeForSession: "work",
          awaitingBaseline: { uuid: null, startedAt: 0 },
          meta: {},
        },
        dispatch: () => {},
        ctx: {},
      });

      assert.equal(store._subs.length, 1);
      handle.unmount();
      assert.equal(store._subs.length, 0);
    });
  });
});
