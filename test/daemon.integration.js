import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, unlinkSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
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

// ─── Daemon security tests (separate daemon instance) ────────────────────────

describe("daemon security", () => {
  describe("socket permissions", () => {
    const SEC_SOCKET = `/tmp/katulong-test-${process.pid}-sec.sock`;
    const SEC_DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-sec-test-"));
    let secDaemon;

    before(async () => {
      if (existsSync(SEC_SOCKET)) unlinkSync(SEC_SOCKET);

      secDaemon = spawn("node", [DAEMON_PATH], {
        env: {
          ...process.env,
          KATULONG_SOCK: SEC_SOCKET,
          KATULONG_DATA_DIR: SEC_DATA_DIR,
        },
        stdio: "pipe",
      });

      secDaemon.stderr.on("data", () => {});
      secDaemon.stdout.on("data", () => {});

      await waitForSocket(SEC_SOCKET);
    });

    after(async () => {
      if (secDaemon) {
        secDaemon.kill("SIGTERM");
        await new Promise((resolve) => secDaemon.on("exit", resolve));
      }
      if (existsSync(SEC_SOCKET)) {
        try { unlinkSync(SEC_SOCKET); } catch {}
      }
    });

    it("creates socket with 0600 permissions", () => {
      const stat = statSync(SEC_SOCKET);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, `socket should have 0600 permissions, got 0${mode.toString(8)}`);
    });

    it("creates PID file with 0600 permissions", () => {
      const pidPath = join(SEC_DATA_DIR, "daemon.pid");
      assert.ok(existsSync(pidPath), "PID file should exist");
      const stat = statSync(pidPath);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, `PID file should have 0600 permissions, got 0${mode.toString(8)}`);
    });

    it("removes a stale socket file on startup", async () => {
      // Write a dummy stale socket file at a new path
      const STALE_SOCKET = `/tmp/katulong-test-${process.pid}-stale.sock`;
      const STALE_DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-stale-test-"));

      // Create a file at that path to simulate a stale socket
      writeFileSync(STALE_SOCKET, "stale");

      let staleDaemon;
      try {
        staleDaemon = spawn("node", [DAEMON_PATH], {
          env: {
            ...process.env,
            KATULONG_SOCK: STALE_SOCKET,
            KATULONG_DATA_DIR: STALE_DATA_DIR,
          },
          stdio: "pipe",
        });

        staleDaemon.stderr.on("data", () => {});
        staleDaemon.stdout.on("data", () => {});

        // Daemon should start successfully, replacing the stale file
        await waitForSocket(STALE_SOCKET);

        // Verify the socket is now a real socket (connectable), not the dummy file
        const probe = createConnection(STALE_SOCKET);
        await new Promise((resolve, reject) => {
          probe.on("connect", () => { probe.destroy(); resolve(); });
          probe.on("error", (err) => reject(new Error(`Stale socket not replaced: ${err.message}`)));
        });
      } finally {
        if (staleDaemon) {
          staleDaemon.kill("SIGTERM");
          await new Promise((resolve) => staleDaemon.on("exit", resolve));
        }
        if (existsSync(STALE_SOCKET)) {
          try { unlinkSync(STALE_SOCKET); } catch {}
        }
        try { rmSync(STALE_DATA_DIR, { recursive: true, force: true }); } catch {}
      }
    });
  });
});

// ─── Error scenario helpers ───────────────────────────────────────────────────

/** Send a message without an id (fire-and-forget; daemon sends no response). */
function sendFireAndForget(socket, msg) {
  socket.write(encode(msg));
}

/**
 * Wait for a broadcast message (no id field) that satisfies `filter`.
 * Resolves with the first matching message.
 */
function waitForBroadcast(socket, filter, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const handler = decoder((msg) => {
      if (filter(msg)) {
        clearTimeout(timer);
        socket.removeListener("data", handler);
        resolve(msg);
      }
    });
    const timer = setTimeout(() => {
      socket.removeListener("data", handler);
      reject(new Error("Broadcast timeout"));
    }, timeoutMs);
    socket.on("data", handler);
  });
}

// ─── Error scenarios (separate daemon instance) ───────────────────────────────

describe("daemon error scenarios", () => {
  let errDaemon;
  let errSock;

  const ERR_SOCKET = `/tmp/katulong-test-${process.pid}-err.sock`;
  const ERR_DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-err-test-"));

  before(async () => {
    if (existsSync(ERR_SOCKET)) unlinkSync(ERR_SOCKET);

    errDaemon = spawn("node", [DAEMON_PATH], {
      env: {
        ...process.env,
        KATULONG_SOCK: ERR_SOCKET,
        KATULONG_DATA_DIR: ERR_DATA_DIR,
      },
      stdio: "pipe",
    });

    errDaemon.stderr.on("data", () => {});
    errDaemon.stdout.on("data", () => {});

    await waitForSocket(ERR_SOCKET);
    errSock = createConnection(ERR_SOCKET);
    await new Promise((resolve) => errSock.on("connect", resolve));
  });

  after(async () => {
    if (errSock) errSock.destroy();
    if (errDaemon) {
      errDaemon.kill("SIGTERM");
      await new Promise((resolve) => errDaemon.on("exit", resolve));
    }
    if (existsSync(ERR_SOCKET)) {
      try { unlinkSync(ERR_SOCKET); } catch {}
    }
  });

  // ── Fire-and-forget failures ──────────────────────────────────────────────

  describe("fire-and-forget failures", () => {
    it("input on dead session does not crash daemon", async () => {
      const sessionName = "ff-dead-input-" + Date.now();
      const clientId = "ff-dead-client-" + Date.now();

      await rpc(errSock, { type: "create-session", name: sessionName });
      await rpc(errSock, { type: "attach", clientId, session: sessionName });

      // Register for exit broadcast before triggering the exit
      const exitPromise = waitForBroadcast(
        errSock,
        (msg) => msg.type === "exit" && msg.session === sessionName
      );

      sendFireAndForget(errSock, { type: "input", clientId, data: "exit\n" });
      await exitPromise; // session.alive is now false

      // Input on dead session — aliveSessionFor returns null, optional chain is no-op
      // The surrounding try/catch (daemon.js line 192) guards against any race
      sendFireAndForget(errSock, { type: "input", clientId, data: "this-should-not-crash\n" });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(result.sessions), "daemon should still respond after input on dead session");

      await rpc(errSock, { type: "delete-session", name: sessionName });
    });

    it("resize on dead session is silently ignored", async () => {
      const sessionName = "ff-dead-resize-" + Date.now();
      const clientId = "ff-resize-client-" + Date.now();

      await rpc(errSock, { type: "create-session", name: sessionName });
      await rpc(errSock, { type: "attach", clientId, session: sessionName });

      const exitPromise = waitForBroadcast(
        errSock,
        (msg) => msg.type === "exit" && msg.session === sessionName
      );

      sendFireAndForget(errSock, { type: "input", clientId, data: "exit\n" });
      await exitPromise;

      // Resize on dead session — aliveSessionFor returns null, optional chain is no-op
      // Session.resize() also guards with if (this.alive) (session.js lines 87-88)
      sendFireAndForget(errSock, { type: "resize", clientId, cols: 120, rows: 40 });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(result.sessions), "daemon should still respond after resize on dead session");

      await rpc(errSock, { type: "delete-session", name: sessionName });
    });

    it("detach on unknown or already-detached client is idempotent", async () => {
      const unknownClientId = "unknown-client-" + Date.now();

      // Send detach for a clientId that was never registered — Map.delete on
      // a missing key is a no-op and should not crash the daemon
      sendFireAndForget(errSock, { type: "detach", clientId: unknownClientId });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(result.sessions), "daemon should be alive after detach of unknown client");
    });
  });

  // ── Malformed messages ────────────────────────────────────────────────────

  describe("malformed messages", () => {
    it("RPC with missing type field returns error without crashing daemon", async () => {
      const result = await rpc(errSock, { data: "no-type-field" });
      assert.ok(result.error, "missing type should return an error");
      assert.match(result.error, /unknown/i);

      const list = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(list.sessions), "daemon should still be alive");
    });

    it("fire-and-forget with missing type does not crash daemon", async () => {
      // No type field: none of the if (type === "...") branches match, returns silently
      sendFireAndForget(errSock, { data: "no-type-field" });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(result.sessions), "daemon should be alive after fire-and-forget with no type");
    });

    it("create-session with missing name does not crash daemon", async () => {
      // msg.name is undefined — spawnSession(undefined) creates a PTY keyed
      // with undefined in the Map. The daemon must not throw.
      const result = await rpc(errSock, { type: "create-session" });

      // Daemon must still be reachable
      const list = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(list.sessions), "daemon should be alive after malformed create-session");

      // Clean up: delete-session with name=undefined targets the same Map key,
      // so this succeeds whether or not the session was created.
      if (!result.error) {
        const del = await rpc(errSock, { type: "delete-session", name: result.name });
        assert.ok(del.ok, "should be able to delete the session created with missing name");
      }
    });

    it("rename-session with missing fields returns error without crashing daemon", async () => {
      // renameSession(undefined, undefined) → sessions.get(undefined) → falsy → returns false
      const result = await rpc(errSock, { type: "rename-session" });
      assert.ok(result.error, "rename with missing fields should return an error");

      const list = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(list.sessions), "daemon should still be alive after malformed rename-session");
    });
  });

  // ── Resource exhaustion ───────────────────────────────────────────────────

  describe("resource exhaustion", () => {
    it("rejects session creation at MAX_SESSIONS limit and recovers after deletion", async () => {
      const MAX_SESSIONS = 20;
      const created = [];

      // Fill up to the limit
      for (let i = 0; i < MAX_SESSIONS; i++) {
        const name = `maxsess-${i}-${Date.now()}`;
        const r = await rpc(errSock, { type: "create-session", name });
        assert.ok(!r.error, `session ${i} creation should succeed, got: ${r.error}`);
        created.push(name);
      }

      // Next creation must be rejected
      const overflow = await rpc(errSock, { type: "create-session", name: "overflow-" + Date.now() });
      assert.ok(overflow.error, "should reject creation when MAX_SESSIONS is reached");
      assert.match(overflow.error, /maximum session limit/i);

      // Delete one session — the slot should open up
      const toDelete = created.pop();
      await rpc(errSock, { type: "delete-session", name: toDelete });

      // Creation must now succeed again
      const recoveryName = "recovery-" + Date.now();
      const recovery = await rpc(errSock, { type: "create-session", name: recoveryName });
      assert.ok(!recovery.error, "should allow creation after a slot is freed");
      created.push(recoveryName);

      // Cleanup
      for (const name of created) {
        await rpc(errSock, { type: "delete-session", name });
      }
    });

    it("output buffer item cap handles single large burst without crashing daemon", async () => {
      const sessionName = "burst-cap-" + Date.now();
      const clientId = "burst-cap-client-" + Date.now();

      await rpc(errSock, { type: "create-session", name: sessionName });
      await rpc(errSock, { type: "attach", clientId, session: sessionName });

      // Generate many small output lines well above MAX_BUFFER (5000 items)
      // PTY batching may group lines, but the ring buffer still evicts by item count
      sendFireAndForget(errSock, {
        type: "input",
        clientId,
        data: "for i in $(seq 1 6000); do printf 'x\\n'; done\n",
      });

      // Allow the loop to run and output to be buffered
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Daemon must still be alive and buffer must be bounded
      const result = await rpc(errSock, {
        type: "attach",
        clientId: "check-" + Date.now(),
        session: sessionName,
      });
      assert.equal(typeof result.buffer, "string", "buffer should be a string");
      const bufferBytes = Buffer.byteLength(result.buffer, "utf8");
      assert.ok(
        bufferBytes <= 5 * 1024 * 1024,
        `buffer size ${bufferBytes} should be within the 5MB cap`
      );

      await rpc(errSock, { type: "delete-session", name: sessionName });
    });
  });

  // ── Session lifecycle edge cases ──────────────────────────────────────────

  describe("session lifecycle edge cases", () => {
    it("attached client receives exit broadcast when session exits", async () => {
      const sessionName = "lifecycle-exit-" + Date.now();
      const clientId = "lifecycle-client-" + Date.now();

      await rpc(errSock, { type: "create-session", name: sessionName });
      await rpc(errSock, { type: "attach", clientId, session: sessionName });

      const exitPromise = waitForBroadcast(
        errSock,
        (msg) => msg.type === "exit" && msg.session === sessionName
      );

      sendFireAndForget(errSock, { type: "input", clientId, data: "exit\n" });

      const exitMsg = await exitPromise;
      assert.equal(exitMsg.type, "exit");
      assert.equal(exitMsg.session, sessionName);
      assert.equal(typeof exitMsg.code, "number", "exit code should be a number");

      await rpc(errSock, { type: "delete-session", name: sessionName });
    });

    it("attach to exited session reports alive false", async () => {
      const sessionName = "lifecycle-dead-attach-" + Date.now();
      const clientId = "lifecycle-dead-client-" + Date.now();

      await rpc(errSock, { type: "create-session", name: sessionName });
      await rpc(errSock, { type: "attach", clientId, session: sessionName });

      const exitPromise = waitForBroadcast(
        errSock,
        (msg) => msg.type === "exit" && msg.session === sessionName
      );

      sendFireAndForget(errSock, { type: "input", clientId, data: "exit\n" });
      await exitPromise;

      // Re-attach after session has exited — should reflect the dead state
      const result = await rpc(errSock, {
        type: "attach",
        clientId: "reattach-" + Date.now(),
        session: sessionName,
      });
      assert.equal(result.alive, false, "attach to exited session should return alive=false");

      await rpc(errSock, { type: "delete-session", name: sessionName });
    });

    it("input after session is deleted by another client does not crash daemon", async () => {
      const sessionName = "lifecycle-deleted-" + Date.now();
      const clientIdA = "clientA-" + Date.now();
      const clientIdB = "clientB-" + Date.now();

      await rpc(errSock, { type: "create-session", name: sessionName });
      await rpc(errSock, { type: "attach", clientId: clientIdA, session: sessionName });
      await rpc(errSock, { type: "attach", clientId: clientIdB, session: sessionName });

      // Simulate one client deleting the shared session
      await rpc(errSock, { type: "delete-session", name: sessionName });

      // The other client's entry is also cleared by removeSession; fire-and-forget
      // input now hits the aliveSessionFor(clientIdA) → null path — must not crash
      sendFireAndForget(errSock, { type: "input", clientId: clientIdA, data: "orphan-input\n" });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await rpc(errSock, { type: "list-sessions" });
      assert.ok(Array.isArray(result.sessions), "daemon should survive input after session deletion");
    });
  });
});
