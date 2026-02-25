import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { createDaemonClient } from "../lib/daemon-client.js";
import { encode, decoder } from "../lib/ndjson.js";

function tmpSocketPath() {
  return join(tmpdir(), `katulong-test-${randomBytes(8).toString("hex")}.sock`);
}

function noop() {}

const silentLog = {
  info: noop, warn: noop, error: noop, debug: noop,
};

/**
 * Create a mock NDJSON server that echoes RPC responses.
 * Returns { server, socketPath, messages, close }.
 * `messages` collects all parsed messages received from the client.
 * By default, the server echoes back each message with the same `id`.
 */
function createMockDaemon(socketPath, handler) {
  const messages = [];
  const server = createServer((conn) => {
    conn.on("data", decoder((msg) => {
      messages.push(msg);
      if (handler) {
        handler(msg, conn);
      } else if (msg.id) {
        // Default: echo the message back as the RPC response
        conn.write(encode({ id: msg.id, ok: true }));
      }
    }));
  });

  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        server,
        socketPath,
        messages,
        close() {
          return new Promise((res) => server.close(res));
        },
      });
    });
  });
}

describe("daemon-client", () => {
  let socketPath;
  let mockDaemon;
  let client;

  beforeEach(() => {
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (client) {
      client.disconnect();
      client = null;
    }
    if (mockDaemon) {
      await mockDaemon.close();
      mockDaemon = null;
    }
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }
  });

  it("connects to daemon socket and reports isConnected", async () => {
    mockDaemon = await createMockDaemon(socketPath);
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });

    assert.strictEqual(client.isConnected(), false, "should not be connected before connect()");

    client.connect();

    // Wait for connection
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(client.isConnected(), true, "should be connected after connect()");
  });

  it("rpc resolves with daemon response", async () => {
    mockDaemon = await createMockDaemon(socketPath);
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });
    client.connect();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const result = await client.rpc({ type: "list-sessions" });
    assert.strictEqual(result.ok, true, "should get response from daemon");
  });

  it("rpc rejects when not connected", async () => {
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });

    await assert.rejects(
      () => client.rpc({ type: "list-sessions" }),
      /Daemon not connected/,
      "should reject when not connected"
    );
  });

  it("rpc rejects on timeout", async () => {
    // Server that never responds
    mockDaemon = await createMockDaemon(socketPath, () => {});
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });
    client.connect();

    await new Promise((resolve) => setTimeout(resolve, 200));

    await assert.rejects(
      () => client.rpc({ type: "list-sessions" }, 100), // 100ms timeout
      /RPC timeout/,
      "should reject on timeout"
    );
  });

  it("non-RPC messages are relayed to bridge", async () => {
    const relayed = [];
    mockDaemon = await createMockDaemon(socketPath, (_msg, conn) => {
      // Send a broadcast-style message (no matching id)
      conn.write(encode({ type: "output", session: "default", data: "hello" }));
    });
    const bridge = { relay: (msg) => relayed.push(msg) };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });
    client.connect();

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Trigger by sending a fire-and-forget message
    client.send({ type: "input", data: "test" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(relayed.length > 0, "bridge should receive relayed messages");
    assert.strictEqual(relayed[0].type, "output");
    assert.strictEqual(relayed[0].data, "hello");
  });

  it("send is no-op when disconnected", () => {
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });

    // Should not throw
    assert.doesNotThrow(() => client.send({ type: "input", data: "test" }));
  });

  it("disconnect cleans up socket and sets isConnected to false", async () => {
    mockDaemon = await createMockDaemon(socketPath);
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });
    client.connect();

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(client.isConnected(), true);

    client.disconnect();
    assert.strictEqual(client.isConnected(), false, "should not be connected after disconnect()");
  });

  it("messages include the correct type field", async () => {
    mockDaemon = await createMockDaemon(socketPath);
    const bridge = { relay: noop };
    client = createDaemonClient({ socketPath, log: silentLog, bridge });
    client.connect();

    await new Promise((resolve) => setTimeout(resolve, 200));

    await client.rpc({ type: "list-sessions" });

    assert.ok(mockDaemon.messages.length > 0, "daemon should receive messages");
    assert.strictEqual(mockDaemon.messages[0].type, "list-sessions");
    assert.ok(mockDaemon.messages[0].id, "RPC messages should have an id");
  });
});
