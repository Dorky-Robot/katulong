/**
 * Regression tests: new terminal tab must accept keyboard input
 *
 * Bug: opening a new terminal tab/session causes the terminal to be
 * unresponsive to keyboard input until the user refreshes the page.
 *
 * Root causes:
 * 1. onFocusChange silently drops the "switch" message when WS is not
 *    in OPEN state — no retry, no fallback. The server never learns
 *    about the new session, so seq-init/data-available never arrive.
 * 2. connection.attached stays true from the previous session during
 *    the switch, so rawSend allows input through — but with no server
 *    switch confirmation, the pull mechanism is never initialized.
 *
 * These tests verify the contract between:
 *   - onFocusChange (app.js) — sends "switch" message
 *   - wsMessageHandlers.switched — sets connection.attached = true
 *   - rawSend (app.js) — guards on connection.attached
 *   - inputSender — routes input to the current session
 */

import { describe, it, before, beforeEach, after } from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Register a custom resolver that redirects /lib/ and /vendor/ to public/.
const projectRoot = new URL("..", import.meta.url).href;
const resolverCode = `
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/") || specifier.startsWith("/vendor/")) {
    return nextResolve("${projectRoot}public" + specifier, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

// Guard: mock.module requires Node >=22.3 with --experimental-test-module-mocks.
if (typeof mock.module !== "function") {
  describe("new-terminal-input", () => {
    it("skipped: mock.module not available in this Node version", () => {});
  });
  process.exit(0);
}

// Mock browser-only modules
const scrollUtilsUrl = new URL("../public/lib/scroll-utils.js", import.meta.url).href;
const basePathUrl = new URL("../public/lib/base-path.js", import.meta.url).href;

await mock.module(scrollUtilsUrl, {
  namedExports: {
    scrollToBottom: () => {},
    terminalWriteWithScroll: () => {},
    viewportOf: () => null,
    isAtBottom: () => true,
  },
});

await mock.module(basePathUrl, {
  namedExports: {
    basePath: "",
  },
});

const { createWebSocketConnection } = await import(
  "../public/lib/websocket-connection.js"
);
const { createInputSender } = await import(
  "../public/lib/input-sender.js"
);

// ── Helpers ────────────────────────────────────────────────────────────

function makeState(overrides = {}) {
  return {
    session: { name: "default", ...overrides.session },
    connection: {
      ws: null,
      transport: null,
      transportType: null,
      attached: false,
      reconnectDelay: 1000,
      ...overrides.connection,
    },
    scroll: {
      userScrolledUpBeforeDisconnect: false,
      ...overrides.scroll,
    },
    update(path, value) {
      const keys = path.split(".");
      let obj = this;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return this;
    },
    updateMany(updates) {
      Object.entries(updates).forEach(([path, value]) =>
        this.update(path, value)
      );
      return this;
    },
  };
}

// Save/restore browser globals
const origLocation = globalThis.location;
const origWebSocket = globalThis.WebSocket;
const origRAF = globalThis.requestAnimationFrame;
const origCAF = globalThis.cancelAnimationFrame;

function installBrowserGlobals() {
  globalThis.location = { protocol: "ws:", host: "localhost:3000" };
  globalThis.WebSocket = FakeWebSocket;
  // Synchronous rAF for deterministic tests
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
}

function restoreBrowserGlobals() {
  globalThis.location = origLocation;
  globalThis.WebSocket = origWebSocket;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
}

class FakeWebSocket {
  readyState = 1;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  _sent = [];
  send(data) {
    this._sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}

/** Simulate the WS message flow: connect, open, attach, then return
 *  the state+connection for further testing. */
function setupAttachedConnection(overrides = {}) {
  const state = makeState(overrides);
  installBrowserGlobals();

  const conn = createWebSocketConnection({
    state,
    term: () => overrides.term || null,
    isAtBottom: () => true,
    ...overrides.deps,
  });

  // Connect and trigger onopen -> sends "attach" message
  conn.connect();
  const ws = state.connection.ws;
  ws.onopen();

  // Simulate server "attached" response
  const transport = state.connection.transport;
  transport.onmessage(JSON.stringify({
    type: "attached",
    session: state.session.name,
  }));

  return { state, conn, ws, transport };
}

// ── rawSend replica ────────────────────────────────────────────────────
// Mirror the rawSend guard from app.js to test the same contract.
function createRawSend(state, inputSender) {
  return (data) => {
    if (!state.connection.attached) return;
    inputSender.send(data);
  };
}

/** Create a minimal mock terminal pool entry. */
function mockTerminalEntry(sessionName, { empty = true } = {}) {
  return {
    term: {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          baseY: empty ? 0 : 1,
          cursorY: empty ? 0 : 5,
          cursorX: empty ? 0 : 10,
        },
      },
      focus: mock.fn(),
    },
    sessionName,
  };
}

/** Create a mock terminal pool with entries. */
function mockTerminalPool(entries = {}) {
  const pool = new Map();
  for (const [name, entry] of Object.entries(entries)) {
    pool.set(name, entry);
  }
  return {
    get: (name) => pool.get(name) || null,
    has: (name) => pool.has(name),
    set: (name, entry) => pool.set(name, entry),
  };
}

/**
 * Replica of the onFocusChange logic from app.js:358-386.
 * This matches the FIXED version of the code — tests assert the fix.
 */
function simulateOnFocusChange(state, terminalPool, sessionName, { wsConnection } = {}) {
  state.update("session.name", sessionName);
  const ws = state.connection.ws;
  const wsOpen = ws?.readyState === 1; // WebSocket.OPEN
  const entry = terminalPool.get(sessionName);
  const buf = entry?.term?.buffer?.active;
  const isEmpty = !buf || (buf.baseY === 0 && buf.cursorY === 0 && buf.cursorX === 0);

  if (wsOpen && entry) {
    if (isEmpty) {
      ws.send(JSON.stringify({
        type: "switch",
        session: sessionName,
        cols: entry.term.cols,
        rows: entry.term.rows,
      }));
    } else {
      ws.send(JSON.stringify({
        type: "resize",
        session: sessionName,
        cols: entry.term.cols,
        rows: entry.term.rows,
      }));
    }
  } else if (isEmpty && wsConnection) {
    // WS not open but we need to switch — trigger reconnection.
    // The onopen handler sends attach for state.session.name.
    wsConnection.enableReconnect();
    wsConnection.connect();
  }
}


// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe("new terminal input: switch message on focus", () => {
  after(restoreBrowserGlobals);

  it("sends 'switch' message when WS is open and terminal buffer is empty", () => {
    const { state, ws } = setupAttachedConnection();

    const newSession = "session-new";
    const entry = mockTerminalEntry(newSession, { empty: true });
    const pool = mockTerminalPool({ [newSession]: entry });

    // Clear sent messages from attach flow
    ws._sent = [];

    simulateOnFocusChange(state, pool, newSession);

    const switchMsg = ws._sent.find((m) => m.type === "switch");
    assert.ok(switchMsg, "must send a 'switch' message for new empty terminal");
    assert.strictEqual(switchMsg.session, newSession);
    assert.strictEqual(switchMsg.cols, 80);
    assert.strictEqual(switchMsg.rows, 24);

    restoreBrowserGlobals();
  });

  it("sends 'resize' (not 'switch') when terminal has content", () => {
    const { state, ws } = setupAttachedConnection();

    const existingSession = "session-existing";
    const entry = mockTerminalEntry(existingSession, { empty: false });
    const pool = mockTerminalPool({ [existingSession]: entry });

    ws._sent = [];
    simulateOnFocusChange(state, pool, existingSession);

    const resizeMsg = ws._sent.find((m) => m.type === "resize");
    assert.ok(resizeMsg, "must send 'resize' for terminal with content");
    assert.ok(!ws._sent.find((m) => m.type === "switch"), "must NOT send 'switch'");

    restoreBrowserGlobals();
  });

  it("updates state.session.name before sending switch", () => {
    const { state, ws } = setupAttachedConnection();

    const newSession = "session-beta";
    const entry = mockTerminalEntry(newSession, { empty: true });
    const pool = mockTerminalPool({ [newSession]: entry });

    simulateOnFocusChange(state, pool, newSession);
    assert.strictEqual(state.session.name, newSession,
      "session name must be updated before switch is sent");

    restoreBrowserGlobals();
  });

  it("treats terminal with no buffer as empty (sends 'switch')", () => {
    const { state, ws } = setupAttachedConnection();

    const newSession = "session-nobuf";
    // Terminal with no buffer property (e.g., not yet fully initialized)
    const entry = {
      term: { cols: 80, rows: 24, buffer: undefined, focus: mock.fn() },
      sessionName: newSession,
    };
    const pool = mockTerminalPool({ [newSession]: entry });

    ws._sent = [];
    simulateOnFocusChange(state, pool, newSession);

    const switchMsg = ws._sent.find((m) => m.type === "switch");
    assert.ok(switchMsg,
      "must send 'switch' when buffer is unavailable (defensive: treat as empty)");

    restoreBrowserGlobals();
  });
});

describe("new terminal input: rawSend guard after switch", () => {
  after(restoreBrowserGlobals);

  it("rawSend drops input when connection.attached is false", () => {
    installBrowserGlobals();
    const state = makeState({ connection: { attached: false } });
    const sent = [];
    const inputSender = createInputSender({
      getWebSocket: () => ({ readyState: 1, send: (d) => sent.push(d) }),
      getSession: () => state.session.name,
      onInput: () => {},
    });
    const rawSend = createRawSend(state, inputSender);

    rawSend("hello");
    assert.strictEqual(sent.length, 0, "input must be dropped when not attached");
    restoreBrowserGlobals();
  });

  it("rawSend allows input when connection.attached is true", () => {
    installBrowserGlobals();
    const state = makeState({ connection: { attached: true } });
    const sent = [];
    const inputSender = createInputSender({
      getWebSocket: () => ({ readyState: 1, send: (d) => sent.push(d) }),
      getSession: () => state.session.name,
      onInput: () => {},
    });
    const rawSend = createRawSend(state, inputSender);

    rawSend("hello");
    assert.strictEqual(sent.length, 1, "input must pass through when attached");
    const payload = JSON.parse(sent[0]);
    assert.strictEqual(payload.type, "input");
    assert.strictEqual(payload.data, "hello");
    restoreBrowserGlobals();
  });

  it("after 'switched' response, rawSend must pass input through", () => {
    const { state, conn, transport } = setupAttachedConnection();

    // Simulate switching to new session
    const newSession = "session-new";
    state.update("session.name", newSession);

    // Simulate server "switched" response
    transport.onmessage(JSON.stringify({
      type: "switched",
      session: newSession,
    }));

    assert.strictEqual(state.connection.attached, true,
      "connection.attached must be true after 'switched' response");
    assert.strictEqual(state.session.name, newSession,
      "session name must match the new session");

    restoreBrowserGlobals();
  });
});

describe("new terminal input: session name sync", () => {
  after(restoreBrowserGlobals);

  it("input sender uses the new session name after focus change", () => {
    installBrowserGlobals();
    const state = makeState({
      session: { name: "alpha" },
      connection: { attached: true },
    });
    const sent = [];
    const inputSender = createInputSender({
      getWebSocket: () => ({ readyState: 1, send: (d) => sent.push(d) }),
      getSession: () => state.session.name,
      onInput: () => {},
    });
    const rawSend = createRawSend(state, inputSender);

    // Simulate focus change to new session
    state.update("session.name", "beta");

    rawSend("x");
    assert.strictEqual(sent.length, 1);
    const payload = JSON.parse(sent[0]);
    assert.strictEqual(payload.session, "beta",
      "input must be routed to the new session, not the old one");

    restoreBrowserGlobals();
  });
});

describe("new terminal input: WS not open race condition", () => {
  after(restoreBrowserGlobals);

  it("triggers reconnection when WS is not open and new session needs switch", () => {
    installBrowserGlobals();
    const state = makeState({
      session: { name: "alpha" },
      connection: { attached: false },  // WS disconnected
    });
    state.connection.ws = null;

    const newSession = "session-new";
    const entry = mockTerminalEntry(newSession, { empty: true });
    const pool = mockTerminalPool({ [newSession]: entry });

    // Create a wsConnection that we can track
    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
    });

    // Simulate onFocusChange with wsConnection available
    simulateOnFocusChange(state, pool, newSession, { wsConnection: conn });

    // Session name is updated
    assert.strictEqual(state.session.name, newSession);

    // wsConnection.connect() was called, so a WS should be created
    const ws = state.connection.ws;
    assert.ok(ws, "connect() must be called to initiate WS connection");

    // Simulate WS opening — it should send attach for the new session
    ws.onopen();

    const attachMsg = ws._sent.find((m) => m.type === "attach");
    assert.ok(attachMsg, "must send attach on reconnect");
    assert.strictEqual(attachMsg.session, newSession,
      "attach must use the new session name");

    restoreBrowserGlobals();
  });

  it("after WS reconnects, the new session must be properly attached", () => {
    const { state, conn, ws, transport } = setupAttachedConnection({
      session: { name: "alpha" },
    });

    // Update session name as onFocusChange would
    state.update("session.name", "beta");

    // Simulate WS close (network blip)
    ws.onclose({ code: 1006 });
    assert.strictEqual(state.connection.attached, false,
      "attached must be false after WS close");

    // Now a new WS connects (simulated by calling connect again)
    conn.connect();
    const newWs = state.connection.ws;
    newWs.onopen();

    const attachMsg = newWs._sent.find((m) => m.type === "attach");
    assert.ok(attachMsg, "must send attach on reconnect");
    assert.strictEqual(attachMsg.session, "beta",
      "attach must use the CURRENT session name (beta), not the old one (alpha)");

    restoreBrowserGlobals();
  });
});

describe("new terminal input: switched handler sets correct state", () => {
  after(restoreBrowserGlobals);

  it("switched handler returns connection.attached = true", () => {
    const state = makeState();
    installBrowserGlobals();
    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
    });

    const result = conn.wsMessageHandlers.switched({ session: "new-session" });
    assert.strictEqual(result.stateUpdates["connection.attached"], true);
    restoreBrowserGlobals();
  });

  it("switched handler updates session.name to server-confirmed name", () => {
    const state = makeState();
    installBrowserGlobals();
    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
    });

    const result = conn.wsMessageHandlers.switched({ session: "server-confirmed" });
    assert.strictEqual(result.stateUpdates["session.name"], "server-confirmed");
    restoreBrowserGlobals();
  });

  it("switched handler emits syncCarouselSubscriptions effect", () => {
    const state = makeState();
    installBrowserGlobals();
    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
    });

    const result = conn.wsMessageHandlers.switched({ session: "s" });
    const effectTypes = result.effects.map((e) => e.type);
    assert.ok(effectTypes.includes("syncCarouselSubscriptions"),
      "must sync carousel subscriptions after switch to get pull data for all tiles");
    restoreBrowserGlobals();
  });
});

describe("new terminal input: end-to-end switch + input flow", () => {
  after(restoreBrowserGlobals);

  it("full flow: focus new session -> switch -> switched -> input accepted", () => {
    // Setup: connected to "alpha"
    const { state, ws, transport } = setupAttachedConnection({
      session: { name: "alpha" },
    });

    // Step 1: Create mock terminal pool with new empty session
    const newSession = "session-beta";
    const entry = mockTerminalEntry(newSession, { empty: true });
    const pool = mockTerminalPool({ [newSession]: entry });

    // Step 2: Simulate onFocusChange (carousel focuses new card)
    ws._sent = [];
    simulateOnFocusChange(state, pool, newSession);

    // Verify switch was sent
    const switchMsg = ws._sent.find((m) => m.type === "switch");
    assert.ok(switchMsg, "switch message must be sent");
    assert.strictEqual(switchMsg.session, newSession);

    // Step 3: Server responds with "switched"
    transport.onmessage(JSON.stringify({
      type: "switched",
      session: newSession,
    }));

    // Step 4: Verify input works
    assert.strictEqual(state.connection.attached, true);
    assert.strictEqual(state.session.name, newSession);

    // Step 5: Create input sender and rawSend, verify input flows
    const inputSender = createInputSender({
      getWebSocket: () => ws,
      getSession: () => state.session.name,
      onInput: () => {},
    });
    const rawSend = createRawSend(state, inputSender);

    rawSend("ls\r");
    const inputMsg = ws._sent.find((m) => m.type === "input");
    assert.ok(inputMsg, "input message must be sent");
    assert.strictEqual(inputMsg.data, "ls\r");
    assert.strictEqual(inputMsg.session, newSession,
      "input must be routed to the new session");

    restoreBrowserGlobals();
  });

  it("full flow: focus new session with WS down -> reconnect -> input accepted", () => {
    installBrowserGlobals();
    const state = makeState({
      session: { name: "alpha" },
      connection: { attached: false },
    });

    // WS is disconnected
    state.connection.ws = null;

    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
    });

    const newSession = "session-gamma";
    const entry = mockTerminalEntry(newSession, { empty: true });
    const pool = mockTerminalPool({ [newSession]: entry });

    // Simulate onFocusChange — should trigger reconnection
    simulateOnFocusChange(state, pool, newSession, { wsConnection: conn });

    // WS should be created by connect()
    const ws = state.connection.ws;
    assert.ok(ws, "WS must be created");
    ws.onopen();

    // Verify attach for new session
    const attachMsg = ws._sent.find((m) => m.type === "attach");
    assert.ok(attachMsg);
    assert.strictEqual(attachMsg.session, newSession);

    // Simulate server "attached" response
    const transport = state.connection.transport;
    transport.onmessage(JSON.stringify({
      type: "attached",
      session: newSession,
    }));

    // Verify input works
    assert.strictEqual(state.connection.attached, true);
    assert.strictEqual(state.session.name, newSession);

    const inputSender = createInputSender({
      getWebSocket: () => ws,
      getSession: () => state.session.name,
      onInput: () => {},
    });
    const rawSend = createRawSend(state, inputSender);

    rawSend("whoami\r");
    const inputMsg = ws._sent.find((m) => m.type === "input");
    assert.ok(inputMsg, "input must be delivered after reconnect + attach");
    assert.strictEqual(inputMsg.session, newSession);

    restoreBrowserGlobals();
  });
});
