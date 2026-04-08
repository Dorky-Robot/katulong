/**
 * Tests for the pure WebSocket message handlers in websocket-connection.js.
 *
 * The wsMessageHandlers are pure functions: given a message and state, they
 * return { stateUpdates, effects }. We mock the browser-only imports and
 * test the handlers in isolation.
 */

import { describe, it, before } from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// The source uses absolute browser paths ("/lib/...") which Node can't resolve.
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

// mock.module requires Node >=22.3 with --experimental-test-module-mocks.
// Guard gracefully so these tests simply skip on older runtimes.
if (typeof mock.module !== "function") {
  describe("wsMessageHandlers", () => {
    it("skipped: mock.module not available in this Node version", () => {});
  });
  // Prevent the rest of the file from executing
  process.exit(0);
}

// Now mock the browser-only modules (using resolved paths)
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

const { createWebSocketConnection } = await import("../public/lib/websocket-connection.js");

function makeState(overrides = {}) {
  return {
    session: { name: "default", ...overrides.session },
    connection: { ws: null, attached: false, reconnectDelay: 1000, ...overrides.connection },
    scroll: { userScrolledUpBeforeDisconnect: false, ...overrides.scroll },
    update(path, value) {
      const keys = path.split(".");
      let obj = this;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return this;
    },
    updateMany(updates) {
      Object.entries(updates).forEach(([path, value]) => this.update(path, value));
      return this;
    },
  };
}

describe("wsMessageHandlers", () => {
  let handlers;

  before(() => {
    const state = makeState();
    const conn = createWebSocketConnection({ state, term: () => null, isAtBottom: () => true });
    handlers = conn.wsMessageHandlers;
  });

  describe("attached", () => {
    it("sets connection.attached, session.name, and clears scroll flag", () => {
      const state = makeState({ scroll: { userScrolledUpBeforeDisconnect: true } });
      const result = handlers.attached({ session: "alpha" }, state);
      assert.strictEqual(result.stateUpdates["connection.attached"], true);
      assert.strictEqual(result.stateUpdates["session.name"], "alpha");
      assert.strictEqual(result.stateUpdates["scroll.userScrolledUpBeforeDisconnect"], false);
    });

    it("emits applySnapshot and updateConnectionIndicator effects", () => {
      // Raptor 3: the attached message carries an initial snapshot that
      // the client applies atomically (resize → clear → write). The
      // `terminalReset` effect is gone — applySnapshot handles it in one
      // step, which is the whole point of the atomic dim-transition path.
      const state = makeState();
      const result = handlers.attached({ session: "alpha", cols: 120, rows: 40, data: "" }, state);
      const effectTypes = result.effects.map(e => e.type);
      assert.ok(effectTypes.includes("applySnapshot"));
      assert.ok(effectTypes.includes("updateConnectionIndicator"));
    });

    it("applySnapshot effect carries dims and data from the message", () => {
      const state = makeState();
      const result = handlers.attached({ session: "alpha", cols: 120, rows: 40, data: "hello" }, state);
      const snap = result.effects.find(e => e.type === "applySnapshot");
      assert.strictEqual(snap.session, "alpha");
      assert.strictEqual(snap.cols, 120);
      assert.strictEqual(snap.rows, 40);
      assert.strictEqual(snap.data, "hello");
    });

    it("includes invalidateSessions with server-confirmed session name", () => {
      const state = makeState({ session: { name: "old-session" } });
      const result = handlers.attached({ session: "my-session" }, state);
      const inv = result.effects.find(e => e.type === "invalidateSessions");
      assert.strictEqual(inv.name, "my-session");
    });
  });

  describe("switched", () => {
    it("updates session name and connection.attached", () => {
      const result = handlers.switched({ session: "new-session" });
      assert.strictEqual(result.stateUpdates["session.name"], "new-session");
      assert.strictEqual(result.stateUpdates["connection.attached"], true);
    });

    it("emits invalidateSessions", () => {
      const result = handlers.switched({ session: "s" });
      const effectTypes = result.effects.map(e => e.type);
      assert.ok(effectTypes.includes("invalidateSessions"));
    });
  });

  describe("reload", () => {
    it("emits reload effect with no state updates", () => {
      const result = handlers.reload();
      assert.deepStrictEqual(result.stateUpdates, {});
      assert.strictEqual(result.effects[0].type, "reload");
    });
  });

  describe("exit", () => {
    it("writes shell exited message", () => {
      const result = handlers.exit({ session: "my-session" });
      assert.deepStrictEqual(result.stateUpdates, {});
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "terminalWrite");
      assert.ok(eff.data.includes("[shell exited]"));
      assert.strictEqual(eff.session, "my-session");
    });
  });

  describe("session-removed", () => {
    it("emits sessionRemoved effect with server-provided session name", () => {
      const result = handlers["session-removed"]({ session: "my-session" });
      assert.strictEqual(result.effects[0].type, "sessionRemoved");
      assert.strictEqual(result.effects[0].name, "my-session");
    });
  });

  describe("session-renamed", () => {
    it("updates session name and emits rename effects", () => {
      const state = makeState({ session: { name: "old" } });
      const result = handlers["session-renamed"]({ name: "new" }, state);
      assert.strictEqual(result.stateUpdates["session.name"], "new");
      const effectTypes = result.effects.map(e => e.type);
      assert.ok(effectTypes.includes("poolRename"));
      assert.ok(effectTypes.includes("tabRename"));
      assert.ok(effectTypes.includes("updateSessionUI"));
    });

    it("passes old and new names to rename effects", () => {
      const state = makeState({ session: { name: "old" } });
      const result = handlers["session-renamed"]({ name: "new" }, state);
      const pool = result.effects.find(e => e.type === "poolRename");
      assert.strictEqual(pool.oldName, "old");
      assert.strictEqual(pool.newName, "new");
    });
  });

  describe("output (server-push)", () => {
    it("emits a single 'output' effect carrying raw bytes for the target session", () => {
      // Raptor 3: `output` messages carry raw bytes at the server's
      // current session dims. No sequence number, no cursor — ordering
      // and dim stability are guaranteed by the server-side coalescer
      // and the atomic snapshot path respectively.
      const result = handlers.output({ session: "my-session", data: "hello" });
      assert.deepStrictEqual(result.stateUpdates, {});
      assert.strictEqual(result.effects.length, 1);
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "output");
      assert.strictEqual(eff.session, "my-session");
      assert.strictEqual(eff.data, "hello");
    });
  });

  describe("snapshot (mid-session dim transition)", () => {
    it("emits applySnapshot carrying the new dims and serialized data", () => {
      // Snapshot messages are the only channel for dim changes in
      // Raptor 3. The client applies them atomically between output
      // bytes so no `output` frame for this session can land on a
      // mismatched grid.
      const result = handlers.snapshot({ session: "my-session", cols: 80, rows: 24, data: "hi" });
      assert.deepStrictEqual(result.stateUpdates, {});
      assert.strictEqual(result.effects.length, 1);
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "applySnapshot");
      assert.strictEqual(eff.session, "my-session");
      assert.strictEqual(eff.cols, 80);
      assert.strictEqual(eff.rows, 24);
      assert.strictEqual(eff.data, "hi");
    });
  });

  describe("credential-registered", () => {
    it("emits refreshTokensAfterRegistration", () => {
      const result = handlers["credential-registered"]();
      assert.strictEqual(result.effects[0].type, "refreshTokensAfterRegistration");
    });
  });

  describe("server-draining", () => {
    it("emits log and fastReconnect effects", () => {
      const result = handlers["server-draining"]();
      const effectTypes = result.effects.map(e => e.type);
      assert.ok(effectTypes.includes("log"));
      assert.ok(effectTypes.includes("fastReconnect"));
    });
  });

  describe("notification", () => {
    it("emits showNotification effect with title and message", () => {
      const result = handlers.notification({ title: "Build done", message: "Tests passed" });
      assert.deepStrictEqual(result.stateUpdates, {});
      assert.strictEqual(result.effects.length, 1);
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "showNotification");
      assert.strictEqual(eff.title, "Build done");
      assert.strictEqual(eff.message, "Tests passed");
    });

    it("passes undefined title/message when not provided", () => {
      const result = handlers.notification({});
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "showNotification");
      assert.strictEqual(eff.title, undefined);
      assert.strictEqual(eff.message, undefined);
    });
  });
});

describe("showNotification effect handler", () => {
  it("calls onNotification with title and message", () => {
    let called = null;
    const state = makeState();
    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
      onNotification: (title, message) => { called = { title, message }; },
    });
    // Execute the showNotification effect directly (same path as WS onmessage)
    conn.executeEffect({ type: "showNotification", title: "Alert", message: "Hello" });
    assert.deepStrictEqual(called, { title: "Alert", message: "Hello" });
  });

  it("does not throw when onNotification is not provided", () => {
    const state = makeState();
    const conn = createWebSocketConnection({
      state,
      term: () => null,
      isAtBottom: () => true,
    });
    // Should not throw — optional chaining in the handler
    conn.executeEffect({ type: "showNotification", title: "X", message: "Y" });
  });
});

describe("getConnectionState", () => {
  it("starts in disconnected state", () => {
    const state = makeState();
    const conn = createWebSocketConnection({ state, term: () => null, isAtBottom: () => true });
    assert.strictEqual(conn.getConnectionState(), "disconnected");
  });
});

describe("disconnect safety: input guard contract", () => {
  // These tests document the contract that rawSend (in app.js) relies on:
  // state.connection.attached is false when disconnected and true only after
  // the server confirms attachment. This is the flag rawSend checks to drop
  // keystrokes during disconnection.

  it("state.connection.attached is false initially", () => {
    const state = makeState();
    assert.strictEqual(state.connection.attached, false);
  });

  it("attached message sets connection.attached to true", () => {
    const state = makeState();
    const conn = createWebSocketConnection({ state, term: () => null, isAtBottom: () => true });
    const result = conn.wsMessageHandlers.attached({ session: "s" }, state);
    assert.strictEqual(result.stateUpdates["connection.attached"], true);
  });

  it("switched message sets connection.attached to true", () => {
    const state = makeState();
    const conn = createWebSocketConnection({ state, term: () => null, isAtBottom: () => true });
    const result = conn.wsMessageHandlers.switched({ session: "s" }, state);
    assert.strictEqual(result.stateUpdates["connection.attached"], true);
  });

  it("updateConnectionIndicator is emitted on attach (drives overlay toggle)", () => {
    const state = makeState();
    const conn = createWebSocketConnection({ state, term: () => null, isAtBottom: () => true });
    const result = conn.wsMessageHandlers.attached({ session: "s" }, state);
    const effectTypes = result.effects.map(e => e.type);
    assert.ok(effectTypes.includes("updateConnectionIndicator"),
      "attached must emit updateConnectionIndicator so the overlay gets hidden");
  });
});
