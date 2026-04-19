import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// feed.js tries to dynamic-import /vendor/marked and /vendor/dompurify;
// in Node those resolves fail and it falls back to a textContent
// renderer for reply bodies. Tests assert against the fallback — the
// real markdown→HTML pipeline is exercised in the browser.

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
    this._innerHTML = "";
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.parentNode = null;
  }
  // Mirror real DOM: assigning `innerHTML = ""` clears children. Some
  // renderers rely on this to reset a node before rebuilding its body.
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "" || v == null) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
    }
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
  querySelectorAll(sel) {
    // Recursive class- or tag-based search — dumb but enough for the
    // post-render enrichment passes, which only call this for "code".
    const pred = sel.startsWith(".")
      ? (c) => c.className?.includes?.(sel.slice(1))
      : (c) => c.tagName === sel.toUpperCase();
    const out = [];
    const walk = (node) => {
      for (const c of node.children || []) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest() { return null; }
  replaceWith() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
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

// Stub global document for feed.js. createTreeWalker and
// createDocumentFragment give the post-render enrichment passes
// enough of an API to no-op quietly: the text-node walker never
// advances because FakeElement doesn't track text nodes, and the
// code-linkifier's querySelectorAll returns [] since renderMarkdown's
// Node fallback writes textContent (no <code> children are built).
globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
  createTextNode(text) { return { nodeType: 3, nodeValue: text, replaceWith() {} }; },
  createDocumentFragment() {
    return { appendChild() {} };
  },
  createTreeWalker() {
    return { currentNode: null, nextNode() { return null; } };
  },
};
globalThis.NodeFilter = {
  SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 3, FILTER_REJECT: 2,
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

const { feedRenderer, parseReplyOptions, buildReplyTokens, looksLikeFilePath, parsePathAndLine } = await import(
  new URL("../public/lib/tile-renderers/feed.js", import.meta.url).href
);

describe("parseReplyOptions", () => {
  it("returns [] when there's no trailing option list", () => {
    assert.deepEqual(parseReplyOptions(""), []);
    assert.deepEqual(parseReplyOptions("plain prose, nothing numbered"), []);
    assert.deepEqual(parseReplyOptions("1. lonely one-item list"), []);
  });

  it("pulls a trailing numbered list off the end", () => {
    const text = `Which approach do you prefer?\n\n1. Merge first\n2. Rebase first\n3. Abort`;
    assert.deepEqual(parseReplyOptions(text), [
      { key: "1", label: "Merge first" },
      { key: "2", label: "Rebase first" },
      { key: "3", label: "Abort" },
    ]);
  });

  it("stops at the first non-option, non-blank line (only the TAIL qualifies)", () => {
    const text = `Here's a recap:\n1. First\n2. Second\nNow, what next?\n1. Merge\n2. Abort`;
    assert.deepEqual(parseReplyOptions(text), [
      { key: "1", label: "Merge" },
      { key: "2", label: "Abort" },
    ]);
  });

  it("accepts `1)` style as well as `1.`", () => {
    assert.deepEqual(parseReplyOptions(`Pick one:\n1) A\n2) B`), [
      { key: "1", label: "A" },
      { key: "2", label: "B" },
    ]);
  });
});

describe("buildReplyTokens", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(buildReplyTokens("", new Map()), []);
  });

  it("returns a single text token when there are no placeholders", () => {
    assert.deepEqual(
      buildReplyTokens("hello claude", new Map()),
      [{ type: "text", value: "hello claude" }],
    );
  });

  it("splits around placeholders that have a mapped path", () => {
    const paths = new Map([[1, "/uploads/a.png"], [2, "/uploads/b.png"]]);
    assert.deepEqual(
      buildReplyTokens("before [Image #1] middle [Image #2] after", paths),
      [
        { type: "text", value: "before " },
        { type: "image", path: "/uploads/a.png" },
        { type: "text", value: " middle " },
        { type: "image", path: "/uploads/b.png" },
        { type: "text", value: " after" },
      ],
    );
  });

  it("keeps placeholders with no mapped path as literal text", () => {
    // User pastes `[Image #99]` from somewhere else — we have no stash
    // for N=99, so we leave the text untouched rather than silently
    // dropping it.
    const paths = new Map([[1, "/uploads/a.png"]]);
    assert.deepEqual(
      buildReplyTokens("see [Image #99] and [Image #1]", paths),
      [
        { type: "text", value: "see [Image #99] and " },
        { type: "image", path: "/uploads/a.png" },
      ],
    );
  });

  it("coalesces adjacent text segments (literal placeholder + prose)", () => {
    const paths = new Map();
    assert.deepEqual(
      buildReplyTokens("a [Image #5] b", paths),
      [{ type: "text", value: "a [Image #5] b" }],
    );
  });

  it("handles back-to-back placeholders with no text between", () => {
    const paths = new Map([[1, "/a.png"], [2, "/b.png"]]);
    assert.deepEqual(
      buildReplyTokens("[Image #1][Image #2]", paths),
      [
        { type: "image", path: "/a.png" },
        { type: "image", path: "/b.png" },
      ],
    );
  });

  it("handles a textarea that is only a placeholder", () => {
    const paths = new Map([[1, "/a.png"]]);
    assert.deepEqual(
      buildReplyTokens("[Image #1]", paths),
      [{ type: "image", path: "/a.png" }],
    );
  });
});

describe("looksLikeFilePath", () => {
  it("accepts home-rooted paths", () => {
    assert.equal(looksLikeFilePath("~/Projects/dorky_robot"), true);
    assert.equal(looksLikeFilePath("~/.claude/worktrees/file-link-cwd"), true);
  });

  it("accepts absolute paths with at least one additional segment", () => {
    assert.equal(looksLikeFilePath("/Users/felixflores/Projects"), true);
    assert.equal(looksLikeFilePath("/var/log/app.log"), true);
    // single-segment absolute path is suspicious (bare "/" or "/tmp" alone)
    assert.equal(looksLikeFilePath("/"), false);
    assert.equal(looksLikeFilePath("/tmp"), false);
  });

  it("accepts filename:line references with known extensions", () => {
    assert.equal(looksLikeFilePath("app-routes.js:99"), true);
    assert.equal(looksLikeFilePath("vision.md"), true);
    assert.equal(looksLikeFilePath("feed.js"), true);
  });

  it("accepts relative paths with a filename extension", () => {
    assert.equal(looksLikeFilePath("docs/file-link-worktree-resolution.md"), true);
    assert.equal(looksLikeFilePath("lib/session-child-counter.js:68"), true);
    assert.equal(looksLikeFilePath("public/app.js"), true);
  });

  it("rejects dotted identifiers that just look like paths", () => {
    // `session.meta.claude` is a property path in our own code —
    // `claude` isn't in the known-ext whitelist and there's no slash,
    // so we don't linkify it. This is the regression case: if we
    // accept `foo.claude` we'd linkify dozens of false positives in
    // every reply that talks about meta namespaces.
    assert.equal(looksLikeFilePath("session.meta.claude"), false);
    assert.equal(looksLikeFilePath("foo.bar.baz"), false);
    assert.equal(looksLikeFilePath("e.g"), false);
  });

  it("rejects URLs, CSS selectors, dotfiles with no dir, and prose", () => {
    assert.equal(looksLikeFilePath("https://example.com/foo"), false);
    assert.equal(looksLikeFilePath(".feed-tile-reply-file"), false);
    assert.equal(looksLikeFilePath(".env"), false);
    assert.equal(looksLikeFilePath("hello world"), false);
    assert.equal(looksLikeFilePath("click here"), false);
    assert.equal(looksLikeFilePath(""), false);
    assert.equal(looksLikeFilePath(null), false);
    assert.equal(looksLikeFilePath(undefined), false);
  });

  it("rejects strings with angle brackets, quotes, or backticks", () => {
    assert.equal(looksLikeFilePath("<div>"), false);
    assert.equal(looksLikeFilePath("\"quoted.js\""), false);
    assert.equal(looksLikeFilePath("`code`"), false);
  });
});

describe("parsePathAndLine", () => {
  it("splits off a trailing :line marker", () => {
    assert.deepEqual(parsePathAndLine("app-routes.js:99"), {
      path: "app-routes.js", line: 99,
    });
    assert.deepEqual(parsePathAndLine("/abs/path/file.js:12"), {
      path: "/abs/path/file.js", line: 12,
    });
  });

  it("returns line=null when no :N suffix", () => {
    assert.deepEqual(parsePathAndLine("~/Projects/dorky_robot"), {
      path: "~/Projects/dorky_robot", line: null,
    });
    assert.deepEqual(parsePathAndLine("vision.md"), {
      path: "vision.md", line: null,
    });
  });
});

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
      // Generic topic — no claudeUuid, so no open-terminal button:
      // [backBtn, title, closeBtn]
      assert.equal(header.children.length, 3);
      assert.equal(header.children[0].className, "feed-tile-back-btn");
      assert.equal(header.children[1].textContent, "my/topic");
      assert.equal(header.children[2].className, "feed-tile-close-btn");
    });

    it("adds an open-terminal button for claude/<uuid> topics that dispatches katulong:open-terminal-for-uuid", () => {
      // The terminal button is the reverse of openAgentFeedTile — from a
      // feed tile, jump back to the terminal running that Claude
      // session. The feed doesn't own the ui-store, so it only announces
      // intent; app.js owns the find-or-create decision.
      const uuid = "11111111-2222-3333-4444-555555555555";
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: `claude/${uuid}`, meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const header = el.children[0].children[0];
      assert.equal(header.children.length, 4, "claude topic header has 4 children");
      const openTerminalBtn = header.children[2];
      assert.equal(openTerminalBtn.className, "feed-tile-open-terminal-btn");
      assert.equal(openTerminalBtn.tagName, "BUTTON");

      // Clicking fires a CustomEvent with { uuid, topic } and stops
      // propagation so the carousel doesn't eat the click as a drag.
      const dispatched = [];
      const orig = globalThis.window.dispatchEvent;
      globalThis.window.dispatchEvent = (ev) => { dispatched.push(ev); };
      try {
        const clickListener = openTerminalBtn._listeners.click?.[0];
        assert.ok(clickListener, "click listener registered");
        let propagated = true;
        clickListener({ stopPropagation: () => { propagated = false; } });
        assert.equal(propagated, false, "stopPropagation called");
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].type, "katulong:open-terminal-for-uuid");
        assert.deepEqual(dispatched[0].detail, { uuid, topic: `claude/${uuid}` });
      } finally {
        globalThis.window.dispatchEvent = orig;
      }
    });

    it("omits the open-terminal button when the topic isn't a claude/<uuid>", () => {
      // Defense-in-depth: the topic shape decides whether we offer
      // terminal resume. A bare topic has no uuid to pass along.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/not-a-uuid", meta: {} },
        dispatch: () => {},
        ctx: {},
      });
      const header = el.children[0].children[0];
      for (const child of header.children) {
        assert.notEqual(child.className, "feed-tile-open-terminal-btn");
      }
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

    it("renders reply events as a block — clickable header wraps prose + footer", () => {
      // One `reply` event → one reply block with:
      //   block.children = [header, toolsEl]
      //   header.children = [body, footer]
      // The header is clickable so the user can toggle the nested tools
      // list; the toolsEl is empty until a tool event arrives. Footer
      // carries the formatted time so the reader's eye lands on the
      // reply prose first.
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
      const block = list.children[0];
      assert.equal(block.tagName, "DIV");
      assert.ok(
        block.className.includes("feed-status-reply"),
        `expected feed-status-reply, got: ${block.className}`,
      );
      assert.ok(
        block.className.includes("feed-tile-reply-block"),
        `expected feed-tile-reply-block, got: ${block.className}`,
      );
      // First reply is marked is-active (pulse border + auto-expand),
      // but has-tools / is-running only kick in once a tool lands.
      assert.ok(block.className.includes("is-active"), block.className);
      assert.ok(!block.className.includes("has-tools"), block.className);
      assert.ok(!block.className.includes("is-running"), block.className);

      const header = block.children[0];
      assert.equal(header.className, "feed-tile-reply-header");
      const body = header.children[0];
      assert.equal(body.className, "feed-tile-reply-body");
      // In Node the markdown pipeline can't load and feed.js uses the
      // textContent fallback — so the test asserts against that path.
      assert.equal(body.textContent, "All tests pass.");

      const footer = header.children[1];
      assert.equal(footer.className, "feed-tile-reply-footer");
      const timeSpan = footer.children[0];
      assert.equal(timeSpan.className, "feed-tile-row-time");
      assert.ok(timeSpan.textContent, "time span renders a formatted timestamp");

      const toolsEl = block.children[1];
      assert.equal(toolsEl.className, "feed-tile-reply-tools");
      assert.equal(toolsEl.children.length, 0, "no tools yet");
    });

    it("renders file chips for reply.files and fires katulong:open-file on click", () => {
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
            status: "reply",
            entryId: "entry-1",
            step: "Updated the session handler.",
            ts: 1_700_000_000_000,
            files: [
              { path: "/src/session.js" },
              { path: "/src/auth.js", line: 42 },
            ],
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      const list = el.children[0].children[1];
      // Block → [header, toolsEl]; header → [body, footer];
      // footer → [time, files-wrapper].
      const header = list.children[0].children[0];
      const footer = header.children[1];
      assert.equal(footer.className, "feed-tile-reply-footer");
      const filesWrapper = footer.children[1];
      assert.equal(filesWrapper.className, "feed-tile-reply-files");
      assert.equal(filesWrapper.children.length, 2);

      const chipA = filesWrapper.children[0];
      assert.equal(chipA.className, "feed-tile-reply-file");
      assert.equal(chipA.textContent, "session.js");
      assert.equal(chipA.title, "/src/session.js");

      const chipB = filesWrapper.children[1];
      assert.equal(chipB.textContent, "auth.js:42");
      assert.equal(chipB.title, "/src/auth.js:42");

      // Clicking the chip should dispatch katulong:open-file with the
      // full path + line. Click also stops propagation so a future
      // ancestor handler (if any) doesn't double-fire.
      let opened = null;
      window.addEventListener("katulong:open-file", (ev) => { opened = ev.detail; });
      let defaultPrevented = false;
      let stoppedBubble = false;
      const fakeEvent = {
        preventDefault: () => { defaultPrevented = true; },
        stopPropagation: () => { stoppedBubble = true; },
      };
      chipB._listeners.click[0](fakeEvent);
      assert.deepEqual(opened, { path: "/src/auth.js", line: 42 });
      assert.equal(defaultPrevented, true);
      assert.equal(stoppedBubble, true);
    });

    it("renders prompt events distinctly from reply events", () => {
      // User prompts and Claude replies share the list but get
      // different classnames + bodies so the reader can eyeball the
      // conversation flow. Also shared entryId map → a republished
      // prompt updates in place just like a reply would.
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
            status: "prompt", entryId: "p-1",
            step: "refactor the auth handler", ts: 1_700_000_000_000,
          }),
          timestamp: 1_700_000_000_000,
        }),
      });
      eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 2, topic: "claude/abc",
          message: JSON.stringify({
            status: "reply", entryId: "r-1",
            step: "ok, on it", ts: 1_700_000_000_001,
          }),
          timestamp: 1_700_000_000_001,
        }),
      });

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 2);
      assert.ok(list.children[0].className.includes("feed-status-prompt"));
      assert.ok(list.children[1].className.includes("feed-status-reply"));
      assert.equal(list.children[0].children[0].className, "feed-tile-prompt-body");
      assert.equal(list.children[0].children[0].textContent, "refactor the auth handler");
    });

    it("re-rendering the same entryId updates in place (no duplicates)", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const publish = (step) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify({
            status: "reply", entryId: "entry-dup",
            step, ts: 1_700_000_000_000,
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      publish("first");
      publish("second");

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 1, "no duplicate block for same entryId");
      // block → header → body (prose first); assert its updated text.
      const body = list.children[0].children[0].children[0];
      assert.equal(body.className, "feed-tile-reply-body");
      assert.equal(body.textContent, "second");
    });

    it("folds a tool that arrives after a reply into that reply's nested tools list", () => {
      // Option B folding: a tool_use event that lands AFTER a reply
      // belongs to that reply (the reply is what kicked the tool off).
      // The tool row is appended to reply.toolsEl, not to the top-level
      // list — so the list still has one child (the reply block). The
      // reply picks up has-tools + is-running modifier classes so the
      // border animates while work is live.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({ status: "reply", entryId: "r-1", step: "Now running tests.", ts: 1 });
      send({
        status: "tool", toolUseId: "toolu_A", state: "running",
        name: "Bash", target: "npm test", ts: 2,
      });

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 1, "tool folds under reply, not a sibling");
      const block = list.children[0];
      const toolsEl = block.children[1];
      assert.equal(toolsEl.className, "feed-tile-reply-tools");
      assert.equal(toolsEl.children.length, 1, "tool rendered inside the reply");
      assert.ok(
        block.className.includes("has-tools"),
        `expected has-tools, got: ${block.className}`,
      );
      assert.ok(
        block.className.includes("is-running"),
        `expected is-running while tool is live, got: ${block.className}`,
      );
    });

    it("drops is-running once every nested tool has a terminal state", () => {
      // While at least one tool under the reply is still running we
      // pulse the border (is-running). As soon as every tool has
      // landed an ok/error result the class is removed and the border
      // goes solid — signalling the reply's work finished.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({ status: "reply", entryId: "r-1", step: "Running.", ts: 1 });
      send({ status: "tool", toolUseId: "toolu_A", state: "running", name: "Bash", target: "a", ts: 2 });
      send({ status: "tool", toolUseId: "toolu_A", state: "ok", output: "done", ts: 3 });

      const block = el.children[0].children[1].children[0];
      assert.ok(block.className.includes("has-tools"), block.className);
      assert.ok(!block.className.includes("is-running"), block.className);
    });

    it("a new reply takes is-active from the prior reply", () => {
      // Only the most recent reply pulses. When the next reply lands,
      // the prior one drops is-active (border goes calm) and collapses
      // its tools; the new reply inherits the active slot and auto-
      // expands.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({ status: "reply", entryId: "r-1", step: "First.", ts: 1 });
      send({ status: "reply", entryId: "r-2", step: "Second.", ts: 2 });

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 2);
      const first = list.children[0];
      const second = list.children[1];
      assert.ok(!first.className.includes("is-active"), `first: ${first.className}`);
      assert.ok(!first.className.includes("is-expanded"), `first: ${first.className}`);
      assert.ok(second.className.includes("is-active"), `second: ${second.className}`);
      assert.ok(second.className.includes("is-expanded"), `second: ${second.className}`);
    });

    it("tapping a reply header toggles is-expanded", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({ status: "reply", entryId: "r-1", step: "Only.", ts: 1 });
      const block = el.children[0].children[1].children[0];
      const header = block.children[0];
      // Active reply is auto-expanded; one tap collapses, another
      // reopens.
      assert.ok(block.className.includes("is-expanded"), block.className);
      header._listeners.click[0]();
      assert.ok(!block.className.includes("is-expanded"), block.className);
      header._listeners.click[0]();
      assert.ok(block.className.includes("is-expanded"), block.className);
    });

    it("renders a running tool card with state class and tool name", () => {
      // A tool_use event stamps a "running" card so the user sees the
      // in-progress state before the result arrives. The state class
      // drives the animated left border in CSS.
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
            status: "tool",
            toolUseId: "toolu_R1",
            state: "running",
            name: "Bash",
            target: "ls -la",
            ts: 1_700_000_000_000,
          }),
          timestamp: 1_700_000_000_000,
        }),
      });

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 1);
      const row = list.children[0];
      assert.ok(row.className.includes("feed-status-tool"), row.className);
      assert.ok(row.className.includes("feed-tile-tool--running"), row.className);
      // row → <details> → [<summary>, <body>]
      const details = row.children[0];
      const header = details.children[0];
      // header → [name, target, state, time]
      assert.equal(header.children[0].textContent, "Bash");
      assert.equal(header.children[1].textContent, "ls -la");
      assert.equal(header.children[2].textContent, "running");
    });

    it("flips running → ok when a matching tool_result lands", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({
        status: "tool", toolUseId: "toolu_OK", state: "running",
        name: "Read", target: "auth.js",
        ts: 1_700_000_000_000,
      });
      send({
        status: "tool", toolUseId: "toolu_OK", state: "ok",
        output: "file contents here",
        ts: 1_700_000_000_001,
      });

      const list = el.children[0].children[1];
      assert.equal(list.children.length, 1, "same toolUseId updates in place");
      const row = list.children[0];
      assert.ok(row.className.includes("feed-tile-tool--ok"), row.className);
      const header = row.children[0].children[0];
      // Name/target from the running event must survive merge with the
      // ok-only payload (which only carries output + state).
      assert.equal(header.children[0].textContent, "Read");
      assert.equal(header.children[1].textContent, "auth.js");
      assert.equal(header.children[2].textContent, "ok");
      const body = row.children[0].children[1];
      assert.equal(body.children[0].textContent, "file contents here");
    });

    it("flips running → error on is_error result", () => {
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({
        status: "tool", toolUseId: "toolu_ERR", state: "running",
        name: "Bash", target: "false",
        ts: 1_700_000_000_000,
      });
      send({
        status: "tool", toolUseId: "toolu_ERR", state: "error",
        output: "exit 1",
        ts: 1_700_000_000_001,
      });

      const row = el.children[0].children[1].children[0];
      assert.ok(row.className.includes("feed-tile-tool--error"), row.className);
      assert.equal(row.children[0].children[0].children[2].textContent, "error");
    });

    it("does not regress a terminal card back to running on a late republish", () => {
      // Replay order: during a catch-up, the processor can republish
      // events out of order (running → ok, then on the NEXT cycle
      // running again when the slice boundary spans the same turn).
      // The ok state must stick — otherwise a completed card briefly
      // animates like it's still running after the result came in.
      const el = new FakeElement("div");
      feedRenderer.mount(el, {
        id: "feed-1",
        props: { topic: "claude/abc", meta: { type: "progress" } },
        dispatch: () => {},
        ctx: {},
      });

      const send = (body) => eventSources[0].onmessage({
        data: JSON.stringify({
          seq: 1, topic: "claude/abc",
          message: JSON.stringify(body),
          timestamp: 1_700_000_000_000,
        }),
      });

      send({
        status: "tool", toolUseId: "toolu_KEEP", state: "running",
        name: "Bash", target: "ls", ts: 1_700_000_000_000,
      });
      send({
        status: "tool", toolUseId: "toolu_KEEP", state: "ok",
        output: "a\nb", ts: 1_700_000_000_001,
      });
      // Late running republish — must not clobber the ok state.
      send({
        status: "tool", toolUseId: "toolu_KEEP", state: "running",
        name: "Bash", target: "ls", ts: 1_700_000_000_000,
      });

      const row = el.children[0].children[1].children[0];
      assert.ok(row.className.includes("feed-tile-tool--ok"), row.className);
      const body = row.children[0].children[1];
      assert.equal(body.children[0].textContent, "a\nb");
    });

    it("silently drops legacy narrative / completion / summary / reply-title events", () => {
      // Old topic logs (from the pre-flatten narrator) still contain
      // these event types. New renderers ignore them rather than
      // crashing or rendering raw JSON.
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
        { status: "reply-title", entryId: "whatever", title: "stale" },
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
