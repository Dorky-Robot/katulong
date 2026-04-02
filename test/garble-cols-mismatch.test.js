/**
 * Tests for the terminal column mismatch fix.
 *
 * The bug: when no terminal is available (e.g., during initial connection),
 * the fallback cols/rows values were hardcoded to 80/24. The PTY was created
 * at 80 cols, but xterm.js opened at 82 cols, causing garbled output from
 * column mismatch. The fix uses TERMINAL_COLS (82) and TERMINAL_ROWS_DEFAULT
 * (24) from terminal-config.js as the fallback values.
 */

import { describe, it, before } from "node:test";
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
  describe("garble-cols-mismatch", () => {
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

const { DEFAULT_COLS, TERMINAL_COLS, TERMINAL_ROWS_DEFAULT } = await import(
  "../public/lib/terminal-config.js"
);
const { createWebSocketConnection } = await import(
  "../public/lib/websocket-connection.js"
);

function makeState(overrides = {}) {
  return {
    session: { name: "default", ...overrides.session },
    connection: {
      ws: null,
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

describe("terminal-config constants", () => {
  it("DEFAULT_COLS is 82", () => {
    assert.strictEqual(DEFAULT_COLS, 82);
  });

  it("TERMINAL_COLS backward compat alias equals DEFAULT_COLS", () => {
    assert.strictEqual(TERMINAL_COLS, DEFAULT_COLS);
  });

  it("TERMINAL_ROWS_DEFAULT is 24", () => {
    assert.strictEqual(TERMINAL_ROWS_DEFAULT, 24);
  });
});

describe("cols/rows fallback in connect()", () => {
  it("uses DEFAULT_COLS (82) as fallback when terminal is null", () => {
    // Capture the message sent via WebSocket during connect().
    // We inject a fake WebSocket via state.connection.ws that records
    // what gets sent, then trigger onopen to exercise the fallback path.
    const sent = [];
    const state = makeState();

    // Stub browser globals needed by connect()
    const origLocation = globalThis.location;
    const origWebSocket = globalThis.WebSocket;
    globalThis.location = { protocol: "ws:", host: "localhost:3000" };
    globalThis.WebSocket = class FakeWebSocket {
      readyState = 1;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      send(data) {
        sent.push(JSON.parse(data));
      }
      close() {}
    };

    try {
      const conn = createWebSocketConnection({
        state,
        term: () => null, // no terminal — triggers fallback
        isAtBottom: () => true,
      });

      conn.connect();

      // Trigger onopen to exercise the attach message path
      const ws = state.connection.ws;
      ws.onopen();

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, "attach");
      assert.strictEqual(
        sent[0].cols,
        82,
        "fallback cols should be DEFAULT_COLS (82), not 80"
      );
    } finally {
      globalThis.location = origLocation;
      globalThis.WebSocket = origWebSocket;
    }
  });

  it("uses TERMINAL_ROWS_DEFAULT (24) as fallback when terminal is null", () => {
    const sent = [];
    const state = makeState();

    const origLocation = globalThis.location;
    const origWebSocket = globalThis.WebSocket;
    globalThis.location = { protocol: "ws:", host: "localhost:3000" };
    globalThis.WebSocket = class FakeWebSocket {
      readyState = 1;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      send(data) {
        sent.push(JSON.parse(data));
      }
      close() {}
    };

    try {
      const conn = createWebSocketConnection({
        state,
        term: () => null,
        isAtBottom: () => true,
      });

      conn.connect();
      state.connection.ws.onopen();

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, "attach");
      assert.strictEqual(
        sent[0].rows,
        24,
        "fallback rows should be TERMINAL_ROWS_DEFAULT (24)"
      );
    } finally {
      globalThis.location = origLocation;
      globalThis.WebSocket = origWebSocket;
    }
  });

  it("uses terminal cols/rows when terminal is available", () => {
    const sent = [];
    const state = makeState();
    const fakeTerm = { cols: 120, rows: 40 };

    const origLocation = globalThis.location;
    const origWebSocket = globalThis.WebSocket;
    globalThis.location = { protocol: "ws:", host: "localhost:3000" };
    globalThis.WebSocket = class FakeWebSocket {
      readyState = 1;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      send(data) {
        sent.push(JSON.parse(data));
      }
      close() {}
    };

    try {
      const conn = createWebSocketConnection({
        state,
        term: () => fakeTerm,
        isAtBottom: () => true,
      });

      conn.connect();
      state.connection.ws.onopen();

      assert.strictEqual(sent[0].cols, 120, "should use terminal cols");
      assert.strictEqual(sent[0].rows, 40, "should use terminal rows");
    } finally {
      globalThis.location = origLocation;
      globalThis.WebSocket = origWebSocket;
    }
  });
});

describe("websocket-connection imports DEFAULT_COLS and TERMINAL_ROWS_DEFAULT", () => {
  it("module loads successfully with terminal-config constants", () => {
    // If websocket-connection.js failed to import DEFAULT_COLS or
    // TERMINAL_ROWS_DEFAULT, the dynamic import at the top of this
    // file would have thrown. The fact that createWebSocketConnection
    // is a function proves the import succeeded.
    assert.strictEqual(typeof createWebSocketConnection, "function");
  });

  it("fallback values match the terminal-config constants exactly", () => {
    // End-to-end check: the fallback used in connect() matches
    // the constants from terminal-config.js.
    const sent = [];
    const state = makeState();

    const origLocation = globalThis.location;
    const origWebSocket = globalThis.WebSocket;
    globalThis.location = { protocol: "ws:", host: "localhost:3000" };
    globalThis.WebSocket = class FakeWebSocket {
      readyState = 1;
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      send(data) {
        sent.push(JSON.parse(data));
      }
      close() {}
    };

    try {
      const conn = createWebSocketConnection({
        state,
        term: () => null,
        isAtBottom: () => true,
      });

      conn.connect();
      state.connection.ws.onopen();

      assert.strictEqual(
        sent[0].cols,
        DEFAULT_COLS,
        "connect() fallback cols must equal DEFAULT_COLS"
      );
      assert.strictEqual(
        sent[0].rows,
        TERMINAL_ROWS_DEFAULT,
        "connect() fallback rows must equal TERMINAL_ROWS_DEFAULT"
      );
    } finally {
      globalThis.location = origLocation;
      globalThis.WebSocket = origWebSocket;
    }
  });
});
