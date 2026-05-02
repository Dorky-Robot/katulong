/**
 * remote-terminal tile renderer — protocol surface tests.
 *
 * Pins the renderer's contract with the peer katulong:
 *   - WS URL composition (api_key on URL, ws/wss scheme rewrite)
 *   - Initial attach frame on open (with fitted cols/rows)
 *   - Server-message handling: attached, seq-init, output (push),
 *     data-available → pull, pull-response, pull-snapshot, exit
 *   - Client-message emission: input on xterm typing, resize on
 *     ResizeObserver fire
 *   - Lifecycle: unmount closes the WS and disposes the terminal
 *
 * Why these specific assertions
 *   These are the exact frames the cross-instance spike depends on
 *   (see lib/ws-manager.js handlers). If a future refactor changes the
 *   shape — say, drops `session` from a frame, or stops calling pull on
 *   data-available — the spike's "tap a peer's session and see live
 *   output" UX silently breaks. The cost of catching that here vs. in
 *   manual iPad testing is the whole point of this file.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

if (typeof mock.module !== "function") {
  describe("remote-terminal-tile", () => {
    it("skipped: mock.module not available in this Node version", () => {});
  });
  process.exit(0);
}

// ── DOM stubs ────────────────────────────────────────────────────
class FakeElement {
  constructor(tag) {
    this.tagName = tag?.toUpperCase() || "DIV";
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.style = {};
    this._innerHTML = "";
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
  addEventListener() {}
}

globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
};
globalThis.window = {};

// ── ResizeObserver stub. Captures the callback so tests can fire it. ──
let resizeObserverCb = null;
let resizeObserverDisconnects = 0;
globalThis.ResizeObserver = class {
  constructor(cb) { resizeObserverCb = cb; }
  observe() {}
  disconnect() { resizeObserverDisconnects += 1; }
};

// ── WebSocket stub ───────────────────────────────────────────────
class FakeWebSocket {
  constructor(url) {
    FakeWebSocket.lastInstance = this;
    FakeWebSocket.urlsConstructed.push(url);
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // Test helpers
  _open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  _serverMessage(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  _serverClose(code = 1006) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code });
  }
}
FakeWebSocket.urlsConstructed = [];
FakeWebSocket.lastInstance = null;
globalThis.WebSocket = FakeWebSocket;

// ── xterm Terminal + FitAddon stubs ──────────────────────────────
class FakeTerminal {
  constructor(opts) {
    FakeTerminal.lastInstance = this;
    this.opts = opts;
    this.cols = opts?.cols ?? 80;
    this.rows = opts?.rows ?? 24;
    this.writes = [];
    this.dataHandlers = [];
    this.disposed = false;
    this.resetCalls = 0;
    this.openTarget = null;
    this.addons = [];
  }
  loadAddon(addon) { this.addons.push(addon); }
  open(target) { this.openTarget = target; }
  write(data) { this.writes.push(data); }
  reset() { this.resetCalls += 1; this.writes.length = 0; }
  dispose() { this.disposed = true; }
  focus() {}
  blur() {}
  onData(fn) { this.dataHandlers.push(fn); return { dispose: () => {} }; }
  // test helper
  _userTyped(data) { for (const h of this.dataHandlers) h(data); }
  _setSize(cols, rows) { this.cols = cols; this.rows = rows; }
}
FakeTerminal.lastInstance = null;

class FakeFitAddon {
  constructor() { FakeFitAddon.lastInstance = this; this.fitCalls = 0; }
  fit() { this.fitCalls += 1; }
}
FakeFitAddon.lastInstance = null;

// Resolve the renderer's relative imports to real filesystem URLs so
// mock.module can intercept by exact specifier. If the renderer moves
// in the tree, update both the relative path here and in the renderer.
const xtermUrl = new URL("../public/vendor/xterm/xterm.esm.js", import.meta.url).href;
const fitUrl   = new URL("../public/vendor/xterm/addon-fit.esm.js", import.meta.url).href;
mock.module(xtermUrl, { namedExports: { Terminal: FakeTerminal } });
mock.module(fitUrl,   { namedExports: { FitAddon: FakeFitAddon } });

const { remoteTerminalRenderer } = await import(
  new URL("../public/lib/tile-renderers/remote-terminal.js", import.meta.url).href
);

// ── Helpers ──────────────────────────────────────────────────────
function freshState() {
  FakeWebSocket.urlsConstructed = [];
  FakeWebSocket.lastInstance = null;
  FakeTerminal.lastInstance = null;
  FakeFitAddon.lastInstance = null;
  resizeObserverCb = null;
  resizeObserverDisconnects = 0;
}

function mountArgs(props) {
  return {
    el: new FakeElement("div"),
    api: {
      id: "rt-test",
      props,
      dispatch: () => {},
      ctx: {},
    },
  };
}

function sentFrames(ws) {
  return ws.sent.map((s) => JSON.parse(s));
}

const VALID_PROPS = {
  peerUrl: "https://katulong-prime.example",
  apiKey:  "secret-key",
  session: "kat_LYdRwT3VYPoABlfMs6Jpn",
};

// ── Tests ────────────────────────────────────────────────────────
describe("remoteTerminalRenderer.describe", () => {
  it("derives a label from peerUrl host + session when none provided", () => {
    const d = remoteTerminalRenderer.describe(VALID_PROPS);
    assert.match(d.title, /katulong-prime\.example/);
    assert.match(d.title, /kat_LYdRwT/);
    assert.equal(d.icon, "terminal-window");
  });

  it("uses an explicit label when provided", () => {
    const d = remoteTerminalRenderer.describe({ ...VALID_PROPS, label: "prime · home" });
    assert.equal(d.title, "prime · home");
  });

  it("is non-persistable for the spike (api keys must not round-trip ui-store)", () => {
    // This is a load-bearing assertion. If someone flips persistable to
    // true without designing keystore separation first, plaintext api
    // keys land in localStorage. Keep this test failing until that
    // design exists.
    assert.equal(remoteTerminalRenderer.describe(VALID_PROPS).persistable, false);
  });
});

describe("remoteTerminalRenderer.mount — bad props", () => {
  beforeEach(freshState);

  it("renders an error message and does NOT open a WebSocket when props are missing", () => {
    const { el, api } = mountArgs({ peerUrl: "https://x", session: "s" }); // no apiKey
    const handle = remoteTerminalRenderer.mount(el, api);
    assert.match(el.textContent, /missing/);
    assert.equal(FakeWebSocket.urlsConstructed.length, 0);
    handle.unmount();
  });
});

describe("remoteTerminalRenderer.mount — WS URL composition", () => {
  beforeEach(freshState);

  it("rewrites https → wss and appends ?api_key", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const url = FakeWebSocket.urlsConstructed[0];
    assert.match(url, /^wss:/);
    assert.match(url, /katulong-prime\.example/);
    assert.match(url, /api_key=secret-key/);
  });

  it("rewrites http → ws (for plain peers)", () => {
    const { el, api } = mountArgs({ ...VALID_PROPS, peerUrl: "http://localhost:3001" });
    remoteTerminalRenderer.mount(el, api);
    const url = FakeWebSocket.urlsConstructed[0];
    assert.match(url, /^ws:/);
    assert.match(url, /localhost:3001/);
    assert.match(url, /api_key=secret-key/);
  });

  it("URL-encodes the api key", () => {
    const { el, api } = mountArgs({ ...VALID_PROPS, apiKey: "key with space" });
    remoteTerminalRenderer.mount(el, api);
    assert.match(FakeWebSocket.urlsConstructed[0], /api_key=key\+with\+space|api_key=key%20with%20space/);
  });
});

describe("remoteTerminalRenderer.mount — protocol", () => {
  beforeEach(freshState);

  it("sends an attach frame with cols/rows on WS open", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    const frames = sentFrames(ws);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, "attach");
    assert.equal(frames[0].session, VALID_PROPS.session);
    assert.equal(typeof frames[0].cols, "number");
    assert.equal(typeof frames[0].rows, "number");
  });

  it("writes the snapshot from `attached` to the terminal", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws._serverMessage({ type: "attached", session: VALID_PROPS.session, data: "$ ls\nfile.txt\n" });
    assert.deepEqual(FakeTerminal.lastInstance.writes, ["$ ls\nfile.txt\n"]);
  });

  it("writes server-pushed `output` data to the terminal", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws._serverMessage({ type: "seq-init", session: VALID_PROPS.session, seq: 0 });
    ws._serverMessage({ type: "output", session: VALID_PROPS.session, data: "hello\n", cursor: 6, fromSeq: 0 });
    assert.ok(FakeTerminal.lastInstance.writes.includes("hello\n"));
  });

  it("on `data-available` sends a pull from the current fromSeq", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws.sent.length = 0; // clear the attach frame so we focus on pull
    ws._serverMessage({ type: "seq-init", session: VALID_PROPS.session, seq: 42 });
    ws._serverMessage({ type: "data-available", session: VALID_PROPS.session });
    const frames = sentFrames(ws);
    const pulls = frames.filter((f) => f.type === "pull");
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].session, VALID_PROPS.session);
    assert.equal(pulls[0].fromSeq, 42);
  });

  it("does not send a duplicate pull while one is in flight", () => {
    // Server can fire data-available repeatedly during heavy output;
    // the renderer must pace itself or the WS write buffer balloons.
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws.sent.length = 0;
    ws._serverMessage({ type: "seq-init", session: VALID_PROPS.session, seq: 0 });
    ws._serverMessage({ type: "data-available", session: VALID_PROPS.session });
    ws._serverMessage({ type: "data-available", session: VALID_PROPS.session });
    const pulls = sentFrames(ws).filter((f) => f.type === "pull");
    assert.equal(pulls.length, 1, "second data-available must coalesce while first pull pending");
  });

  it("re-arms pull after a pull-response arrives", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws.sent.length = 0;
    ws._serverMessage({ type: "seq-init", session: VALID_PROPS.session, seq: 0 });
    ws._serverMessage({ type: "data-available", session: VALID_PROPS.session });
    ws._serverMessage({ type: "pull-response", session: VALID_PROPS.session, data: "x", cursor: 1 });
    ws._serverMessage({ type: "data-available", session: VALID_PROPS.session });
    const pulls = sentFrames(ws).filter((f) => f.type === "pull");
    assert.equal(pulls.length, 2, "second data-available after pull-response should fire a fresh pull");
    assert.equal(pulls[1].fromSeq, 1, "fromSeq should advance to the cursor returned by pull-response");
  });

  it("on `pull-snapshot` resets the terminal and writes the fresh snapshot", () => {
    // pull-snapshot fires when the server-side cursor was evicted before
    // the client could pull. The renderer must clear stale buffer state
    // and resync — anything else leaves a permanently corrupted view.
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws._serverMessage({ type: "attached", session: VALID_PROPS.session, data: "old\n" });
    ws._serverMessage({ type: "pull-snapshot", session: VALID_PROPS.session, data: "fresh-pane\n", cursor: 100 });
    assert.equal(FakeTerminal.lastInstance.resetCalls, 1);
    assert.deepEqual(FakeTerminal.lastInstance.writes, ["fresh-pane\n"]);
  });
});

describe("remoteTerminalRenderer.mount — client → server frames", () => {
  beforeEach(freshState);

  it("sends an `input` frame when the user types", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws.sent.length = 0;
    FakeTerminal.lastInstance._userTyped("ls\r");
    const frames = sentFrames(ws);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { type: "input", session: VALID_PROPS.session, data: "ls\r" });
  });

  it("sends a `resize` frame when the ResizeObserver fires after attach", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    ws.sent.length = 0;
    FakeTerminal.lastInstance._setSize(120, 40);
    if (typeof resizeObserverCb === "function") resizeObserverCb([]);
    const resizes = sentFrames(ws).filter((f) => f.type === "resize");
    assert.equal(resizes.length, 1);
    assert.equal(resizes[0].session, VALID_PROPS.session);
    assert.equal(resizes[0].cols, 120);
    assert.equal(resizes[0].rows, 40);
  });

  it("does NOT send `input` when the WS is not open", () => {
    // Dropped input is preferable to a sender that buffers indefinitely;
    // xterm shows what's been processed, peer is the source of truth.
    const { el, api } = mountArgs(VALID_PROPS);
    remoteTerminalRenderer.mount(el, api);
    // Don't call ws._open() — readyState stays CONNECTING (0).
    FakeTerminal.lastInstance._userTyped("x");
    assert.equal(FakeWebSocket.lastInstance.sent.length, 0);
  });
});

describe("remoteTerminalRenderer.mount — lifecycle", () => {
  beforeEach(freshState);

  it("unmount closes the WS, disposes the terminal, and disconnects the resize observer", () => {
    const { el, api } = mountArgs(VALID_PROPS);
    const handle = remoteTerminalRenderer.mount(el, api);
    const ws = FakeWebSocket.lastInstance;
    ws._open();
    handle.unmount();
    assert.equal(ws.closed, true);
    assert.equal(FakeTerminal.lastInstance.disposed, true);
    assert.equal(resizeObserverDisconnects, 1);
    assert.equal(el.children.length, 0);
  });
});
