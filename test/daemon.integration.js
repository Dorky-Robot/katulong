import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { encode, decoder } from "../lib/ndjson.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(__dirname, "..", "daemon.js");
const SOCKET_PATH = `/tmp/katulong-test-${process.pid}.sock`;
const DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-test-"));

function waitForSocket(path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Timed out waiting for daemon socket"));
      }
      const probe = createConnection(path);
      probe.on("connect", () => { probe.destroy(); resolve(); });
      probe.on("error", () => setTimeout(attempt, 100));
    }
    attempt();
  });
}

function rpc(socket, msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => reject(new Error("RPC timeout")), timeoutMs);

    const handler = decoder((response) => {
      if (response.id === id) {
        clearTimeout(timer);
        socket.removeListener("data", handler);
        resolve(response);
      }
    });

    socket.on("data", handler);
    socket.write(encode({ id, ...msg }));
  });
}

describe("daemon integration", () => {
  let daemonProc;
  let sock;

  before(async () => {
    // Clean up stale socket
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

    daemonProc = spawn("node", [DAEMON_PATH], {
      env: { ...process.env, KATULONG_SOCK: SOCKET_PATH, KATULONG_DATA_DIR: DATA_DIR },
      stdio: "pipe",
    });

    // Log daemon stderr for debugging
    daemonProc.stderr.on("data", () => {});
    daemonProc.stdout.on("data", () => {});

    await waitForSocket(SOCKET_PATH);

    sock = createConnection(SOCKET_PATH);
    await new Promise((resolve) => sock.on("connect", resolve));
  });

  after(async () => {
    if (sock) sock.destroy();
    if (daemonProc) {
      daemonProc.kill("SIGTERM");
      await new Promise((resolve) => daemonProc.on("exit", resolve));
    }
    if (existsSync(SOCKET_PATH)) {
      try { unlinkSync(SOCKET_PATH); } catch {}
    }
  });

  it("list-sessions returns empty array initially", async () => {
    const result = await rpc(sock, { type: "list-sessions" });
    assert.ok(Array.isArray(result.sessions));
    assert.equal(result.sessions.length, 0);
  });

  it("create-session creates a session", async () => {
    const result = await rpc(sock, { type: "create-session", name: "test-sess" });
    assert.equal(result.name, "test-sess");
    assert.ok(!result.error);
  });

  it("create-session rejects duplicate name", async () => {
    const result = await rpc(sock, { type: "create-session", name: "test-sess" });
    assert.ok(result.error);
  });

  it("list-sessions shows created session", async () => {
    const result = await rpc(sock, { type: "list-sessions" });
    assert.ok(result.sessions.length >= 1);
    const names = result.sessions.map((s) => s.name);
    assert.ok(names.includes("test-sess"));
  });

  it("attach returns buffer and alive status", async () => {
    const result = await rpc(sock, { type: "attach", clientId: "test-client", session: "test-sess" });
    assert.equal(typeof result.buffer, "string");
    assert.equal(typeof result.alive, "boolean");
  });

  it("rename-session renames a session", async () => {
    const result = await rpc(sock, { type: "rename-session", oldName: "test-sess", newName: "renamed-sess" });
    assert.equal(result.name, "renamed-sess");
    assert.ok(!result.error);

    const list = await rpc(sock, { type: "list-sessions" });
    const names = list.sessions.map((s) => s.name);
    assert.ok(names.includes("renamed-sess"));
    assert.ok(!names.includes("test-sess"));
  });

  it("delete-session removes a session", async () => {
    const result = await rpc(sock, { type: "delete-session", name: "renamed-sess" });
    assert.ok(result.ok);
    assert.ok(!result.error);

    const list = await rpc(sock, { type: "list-sessions" });
    const names = list.sessions.map((s) => s.name);
    assert.ok(!names.includes("renamed-sess"));
  });

  it("delete-session returns error for unknown name", async () => {
    const result = await rpc(sock, { type: "delete-session", name: "nonexistent" });
    assert.ok(result.error);
  });

  it("returns error for unknown RPC message type", async () => {
    const result = await rpc(sock, { type: "unknown-command-xyz", data: "test" });
    assert.ok(result.error, "unknown message type should return an error response");
    assert.match(result.error, /unknown/i);
  });

  it("attach auto-creates a session that does not yet exist", async () => {
    const sessionName = "auto-create-" + Date.now();
    const result = await rpc(sock, {
      type: "attach",
      clientId: "auto-client-" + Date.now(),
      session: sessionName,
      cols: 80,
      rows: 24,
    });
    assert.equal(typeof result.buffer, "string", "auto-created session should return a buffer");
    assert.equal(typeof result.alive, "boolean", "auto-created session should return alive status");
    assert.ok(result.alive, "newly created session should be alive");

    // Verify session appears in the list
    const list = await rpc(sock, { type: "list-sessions" });
    const names = list.sessions.map((s) => s.name);
    assert.ok(names.includes(sessionName), "auto-created session should appear in list");

    // Cleanup
    await rpc(sock, { type: "delete-session", name: sessionName });
  });

  it("rename-session fails when destination name already exists", async () => {
    await rpc(sock, { type: "create-session", name: "rename-src-" + process.pid });
    await rpc(sock, { type: "create-session", name: "rename-dst-" + process.pid });

    const result = await rpc(sock, {
      type: "rename-session",
      oldName: "rename-src-" + process.pid,
      newName: "rename-dst-" + process.pid,
    });
    assert.ok(result.error, "rename to an existing name should fail");

    // Cleanup
    await rpc(sock, { type: "delete-session", name: "rename-src-" + process.pid });
    await rpc(sock, { type: "delete-session", name: "rename-dst-" + process.pid });
  });

  it("handles concurrent create-session calls with the same name", async () => {
    const sessionName = "concurrent-create-" + Date.now();

    // Fire both RPCs concurrently — Node.js daemon is single-threaded but
    // responses may arrive out-of-order; verify exactly one succeeds.
    const [result1, result2] = await Promise.all([
      rpc(sock, { type: "create-session", name: sessionName }),
      rpc(sock, { type: "create-session", name: sessionName }),
    ]);

    const successes = [result1, result2].filter((r) => !r.error);
    const failures = [result1, result2].filter((r) => r.error);

    assert.equal(successes.length, 1, "exactly one concurrent create should succeed");
    assert.equal(failures.length, 1, "the other should fail as duplicate");

    // Cleanup
    await rpc(sock, { type: "delete-session", name: sessionName });
  });

  it("session persists after a client disconnects and reconnects", async () => {
    const sessionName = "reconnect-persist-" + Date.now();
    await rpc(sock, { type: "create-session", name: sessionName });

    // Open a second independent connection and immediately disconnect it
    const sock2 = createConnection(SOCKET_PATH);
    await new Promise((resolve) => sock2.on("connect", resolve));

    // Verify the session is visible from the second connection
    const list1 = await rpc(sock2, { type: "list-sessions" });
    const names1 = list1.sessions.map((s) => s.name);
    assert.ok(names1.includes(sessionName), "session should be visible from a fresh connection");

    // Disconnect the second socket abruptly (simulates a client crash / disconnect)
    sock2.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify from the original connection that the PTY session still exists
    const list2 = await rpc(sock, { type: "list-sessions" });
    const names2 = list2.sessions.map((s) => s.name);
    assert.ok(names2.includes(sessionName), "PTY session should survive client disconnect");

    // Cleanup
    await rpc(sock, { type: "delete-session", name: sessionName });
  });

  it("double-delete returns error on second attempt", async () => {
    const sessionName = "double-delete-" + Date.now();
    await rpc(sock, { type: "create-session", name: sessionName });

    const first = await rpc(sock, { type: "delete-session", name: sessionName });
    assert.ok(first.ok, "first delete should succeed");
    assert.ok(!first.error);

    const second = await rpc(sock, { type: "delete-session", name: sessionName });
    assert.ok(second.error, "second delete of same session should return an error");
  });

  it("input to dead session does not crash the daemon", async () => {
    const sessionName = "dead-input-test-" + Date.now();
    const clientId = "dead-input-client-" + Date.now();

    // Create a session and attach a client
    await rpc(sock, { type: "create-session", name: sessionName });
    await rpc(sock, { type: "attach", clientId, session: sessionName });

    // Delete the session (kills the PTY)
    await rpc(sock, { type: "delete-session", name: sessionName });

    // Give the PTY exit event time to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send a fire-and-forget input to the now-dead session (no id = no response expected)
    sock.write(encode({ type: "input", clientId, data: "should not crash\n" }));

    // Give the daemon time to process the message
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the daemon is still alive by completing a normal RPC
    const result = await rpc(sock, { type: "list-sessions" });
    assert.ok(Array.isArray(result.sessions), "daemon should still respond after input to dead session");
  });

  it("get-shortcuts returns shortcuts array", async () => {
    const result = await rpc(sock, { type: "get-shortcuts" });
    assert.ok(Array.isArray(result.shortcuts));
  });

  it("set-shortcuts + get-shortcuts round-trip", async () => {
    const shortcuts = [{ label: "Ctrl+T", keys: "ctrl+t" }];
    const setResult = await rpc(sock, { type: "set-shortcuts", data: shortcuts });
    assert.ok(setResult.ok);

    const getResult = await rpc(sock, { type: "get-shortcuts" });
    assert.deepEqual(getResult.shortcuts, shortcuts);
  });

  it("output buffer respects 5MB byte cap under heavy output", async () => {
    // Create a session for testing
    const sessionName = "buffer-test";
    await rpc(sock, { type: "create-session", name: sessionName });

    // Generate output that would exceed 5MB if not capped
    // Use a command that outputs a large amount of data
    const largeChunk = "A".repeat(100000); // 100KB chunk
    const iterations = 60; // 60 * 100KB = 6MB total, exceeds 5MB cap

    // Send command to generate heavy output using yes command
    await rpc(sock, {
      type: "input",
      session: sessionName,
      data: `yes "${largeChunk}" | head -n ${iterations}\n`,
    });

    // Wait for output to be generated
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Attach to get the buffer
    const result = await rpc(sock, { type: "attach", clientId: "buffer-client", session: sessionName });

    // Buffer should not exceed 5MB
    const bufferSize = Buffer.byteLength(result.buffer, "utf8");
    const maxBytes = 5 * 1024 * 1024; // 5MB
    assert.ok(
      bufferSize <= maxBytes,
      `Buffer size ${bufferSize} should not exceed ${maxBytes} bytes`
    );

    // Clean up
    await rpc(sock, { type: "delete-session", name: sessionName });
  });
});
