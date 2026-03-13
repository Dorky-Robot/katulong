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

// Now mock the browser-only modules (using resolved paths)
const scrollUtilsUrl = new URL("../public/lib/scroll-utils.js", import.meta.url).href;
const basePathUrl = new URL("../public/lib/base-path.js", import.meta.url).href;

await mock.module(scrollUtilsUrl, {
  namedExports: {
    scrollToBottom: () => {},
    terminalWriteWithScroll: () => {},
    activeViewport: () => null,
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
    p2p: { peer: null, connected: false, ...overrides.p2p },
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
    it("sets connection.attached and clears scroll flag", () => {
      const state = makeState({ scroll: { userScrolledUpBeforeDisconnect: true } });
      const result = handlers.attached({}, state);
      assert.strictEqual(result.stateUpdates["connection.attached"], true);
      assert.strictEqual(result.stateUpdates["scroll.userScrolledUpBeforeDisconnect"], false);
    });

    it("emits terminalReset, updateP2PIndicator, initP2P, fit effects", () => {
      const state = makeState();
      const result = handlers.attached({}, state);
      const effectTypes = result.effects.map(e => e.type);
      assert.ok(effectTypes.includes("terminalReset"));
      assert.ok(effectTypes.includes("updateP2PIndicator"));
      assert.ok(effectTypes.includes("initP2P"));
      assert.ok(effectTypes.includes("fit"));
    });

    it("includes invalidateSessions with current session name", () => {
      const state = makeState({ session: { name: "my-session" } });
      const result = handlers.attached({}, state);
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

    it("emits updateSessionUI with new name", () => {
      const result = handlers.switched({ session: "new-session" });
      const ui = result.effects.find(e => e.type === "updateSessionUI");
      assert.strictEqual(ui.name, "new-session");
    });

    it("emits invalidateSessions and fit", () => {
      const result = handlers.switched({ session: "s" });
      const effectTypes = result.effects.map(e => e.type);
      assert.ok(effectTypes.includes("invalidateSessions"));
      assert.ok(effectTypes.includes("fit"));
    });
  });

  describe("output", () => {
    it("emits terminalWrite with preserveScroll and useOutputTerm", () => {
      const result = handlers.output({ data: "hello", session: "alpha" });
      assert.deepStrictEqual(result.stateUpdates, {});
      assert.strictEqual(result.effects.length, 1);
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "terminalWrite");
      assert.strictEqual(eff.data, "hello");
      assert.strictEqual(eff.session, "alpha");
      assert.strictEqual(eff.preserveScroll, true);
      assert.strictEqual(eff.useOutputTerm, true);
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
    it("emits sessionRemoved effect", () => {
      const result = handlers["session-removed"]();
      assert.strictEqual(result.effects[0].type, "sessionRemoved");
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

  describe("credential-registered", () => {
    it("emits refreshTokensAfterRegistration", () => {
      const result = handlers["credential-registered"]();
      assert.strictEqual(result.effects[0].type, "refreshTokensAfterRegistration");
    });
  });

  describe("p2p-signal", () => {
    it("passes signal data through", () => {
      const data = { type: "offer", sdp: "..." };
      const result = handlers["p2p-signal"]({ data });
      assert.strictEqual(result.effects[0].type, "p2pSignal");
      assert.strictEqual(result.effects[0].data, data);
    });
  });

  describe("p2p-closed", () => {
    it("sets p2p.connected to false", () => {
      const result = handlers["p2p-closed"]();
      assert.strictEqual(result.stateUpdates["p2p.connected"], false);
    });
  });

  describe("resize-sync", () => {
    it("passes cols and rows to resizeSync effect", () => {
      const result = handlers["resize-sync"]({ cols: 120, rows: 40 });
      const eff = result.effects[0];
      assert.strictEqual(eff.type, "resizeSync");
      assert.strictEqual(eff.cols, 120);
      assert.strictEqual(eff.rows, 40);
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
});
