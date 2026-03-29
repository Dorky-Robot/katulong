import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// tile-sdk-impl.js uses browser APIs (localStorage, navigator, window, document, fetch).
// We stub them minimally for unit testing.

const _nav = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  platform: "MacIntel",
  maxTouchPoints: 0,
};

function setupBrowserGlobals() {
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] ?? null; },
    clear() { store.clear(); },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: _nav, writable: true, configurable: true,
  });
  globalThis.window = {
    matchMedia() { return { matches: true }; },
  };
  globalThis.document = {
    createElement() {
      return {
        style: { cssText: "" },
        textContent: "",
        appendChild() {},
        remove() {},
      };
    },
    body: { appendChild() {} },
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.fetch = async () => ({ ok: false });
  // Reset navigator properties
  _nav.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
  _nav.platform = "MacIntel";
  _nav.maxTouchPoints = 0;
  return store;
}

describe("createTileSDK", () => {
  let store;
  let createTileSDK;

  beforeEach(async () => {
    store = setupBrowserGlobals();
    const mod = await import("../public/lib/tile-sdk-impl.js");
    createTileSDK = mod.createTileSDK;
  });

  it("returns a frozen object with expected keys", () => {
    const sdk = createTileSDK("test");
    assert.deepStrictEqual(Object.keys(sdk).sort(), [
      "api", "platform", "pubsub", "sessions", "storage", "toast", "ws",
    ]);
    assert.ok(Object.isFrozen(sdk));
  });

  describe("sdk.storage", () => {
    it("namespaces keys by tile type", () => {
      const sdk = createTileSDK("plano");
      sdk.storage.set("notes", [1, 2, 3]);
      assert.deepStrictEqual(sdk.storage.get("notes"), [1, 2, 3]);
      // Verify the raw key in localStorage
      assert.strictEqual(store.get("katulong-tile-plano:notes"), "[1,2,3]");
    });

    it("isolates storage between tile types", () => {
      const sdkA = createTileSDK("alpha");
      const sdkB = createTileSDK("beta");
      sdkA.storage.set("x", "aaa");
      sdkB.storage.set("x", "bbb");
      assert.strictEqual(sdkA.storage.get("x"), "aaa");
      assert.strictEqual(sdkB.storage.get("x"), "bbb");
    });

    it("returns null for missing keys", () => {
      const sdk = createTileSDK("test");
      assert.strictEqual(sdk.storage.get("nonexistent"), null);
    });

    it("lists keys for the namespace only", () => {
      const sdk = createTileSDK("test");
      sdk.storage.set("a", 1);
      sdk.storage.set("b", 2);
      store.set("other-prefix:c", "3");
      assert.deepStrictEqual(sdk.storage.keys().sort(), ["a", "b"]);
    });

    it("removes a key", () => {
      const sdk = createTileSDK("test");
      sdk.storage.set("gone", true);
      sdk.storage.remove("gone");
      assert.strictEqual(sdk.storage.get("gone"), null);
    });

    it("clears only its own namespace", () => {
      const sdkA = createTileSDK("alpha");
      const sdkB = createTileSDK("beta");
      sdkA.storage.set("x", 1);
      sdkB.storage.set("y", 2);
      sdkA.storage.clear();
      assert.strictEqual(sdkA.storage.get("x"), null);
      assert.strictEqual(sdkB.storage.get("y"), 2);
    });
  });

  describe("sdk.platform", () => {
    it("detects desktop when not iPad or phone", () => {
      const sdk = createTileSDK("test");
      assert.strictEqual(sdk.platform.isDesktop, true);
      assert.strictEqual(sdk.platform.isIPad, false);
      assert.strictEqual(sdk.platform.isPhone, false);
    });

    it("detects iPad from touch points", () => {
      _nav.maxTouchPoints = 5;
      const sdk = createTileSDK("test");
      assert.strictEqual(sdk.platform.isIPad, true);
      assert.strictEqual(sdk.platform.isDesktop, false);
      _nav.maxTouchPoints = 0;
    });

    it("reports version from deps", () => {
      const sdk = createTileSDK("test", { platform: { version: "1.2.3" } });
      assert.strictEqual(sdk.platform.version, "1.2.3");
    });

    it("reports dark mode", () => {
      const sdk = createTileSDK("test");
      assert.strictEqual(sdk.platform.isDark, true);
    });
  });

  describe("sdk.pubsub", () => {
    it("emits and receives events", () => {
      const sdk = createTileSDK("test");
      const received = [];
      sdk.pubsub.on("test-event", (data) => received.push(data));
      sdk.pubsub.emit("test-event", { x: 1 });
      sdk.pubsub.emit("test-event", { x: 2 });
      assert.deepStrictEqual(received, [{ x: 1 }, { x: 2 }]);
    });

    it("unsubscribes via returned function", () => {
      const sdk = createTileSDK("test");
      const received = [];
      const off = sdk.pubsub.on("e", (d) => received.push(d));
      sdk.pubsub.emit("e", 1);
      off();
      sdk.pubsub.emit("e", 2);
      assert.deepStrictEqual(received, [1]);
    });
  });

  describe("sdk.toast", () => {
    it("calls provided toast function", () => {
      const calls = [];
      const sdk = createTileSDK("test", { toast: (msg, isErr) => calls.push({ msg, isErr }) });
      sdk.toast("hello");
      sdk.toast("fail", { isError: true });
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0].msg, "hello");
      assert.strictEqual(calls[1].isErr, true);
    });
  });

  describe("sdk.ws", () => {
    it("sends JSON to websocket when available", () => {
      const sent = [];
      const sdk = createTileSDK("test", {
        getWs: () => ({ readyState: 1, send: (msg) => sent.push(msg) }),
      });
      sdk.ws.send({ type: "ping" });
      assert.deepStrictEqual(sent, ['{"type":"ping"}']);
    });

    it("does not throw when ws is unavailable", () => {
      const sdk = createTileSDK("test", { getWs: () => null });
      assert.doesNotThrow(() => sdk.ws.send({ type: "ping" }));
    });
  });
});
