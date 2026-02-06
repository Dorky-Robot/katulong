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
