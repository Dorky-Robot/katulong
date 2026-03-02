import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for Sessions CRUD via HTTP routes.
 *
 * Spins up a real daemon + server with an isolated socket and data dir,
 * then exercises the session endpoints the same way the frontend
 * session-manager.js does:
 *   POST   /sessions          — create
 *   GET    /sessions          — list
 *   PUT    /sessions/:name    — rename
 *   DELETE /sessions/:name    — delete
 */

const TEST_PORT = 3010;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function request(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed };
}

describe("Sessions CRUD Integration", () => {
  let daemonProcess;
  let serverProcess;
  let testDataDir;
  const testSocket = `/tmp/katulong-test-sessions-${process.pid}.sock`;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-sessions-test-"));

    const minimalEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KATULONG_DATA_DIR: testDataDir,
      KATULONG_SOCK: testSocket,
      KATULONG_NO_AUTH: "1",
      PORT: String(TEST_PORT),
      SSH_PORT: String(TEST_PORT + 10),
    };

    // Spawn daemon first, then server (mirrors entrypoint.js but with
    // separate processes for consistency with daemon.integration.js)
    daemonProcess = spawn("node", ["daemon.js"], {
      env: minimalEnv,
      stdio: "pipe",
    });
    daemonProcess.stderr.on("data", () => {});
    daemonProcess.stdout.on("data", () => {});

    // Wait for daemon socket
    const { createConnection } = await import("node:net");
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      function attempt() {
        if (Date.now() > deadline) return reject(new Error("Daemon socket timeout"));
        const probe = createConnection(testSocket);
        probe.on("connect", () => { probe.destroy(); resolve(); });
        probe.on("error", () => setTimeout(attempt, 100));
      }
      attempt();
    });

    // Spawn server
    serverProcess = spawn("node", ["server.js"], {
      env: minimalEnv,
      stdio: "pipe",
    });

    let serverOutput = "";
    serverProcess.stderr.on("data", (data) => { serverOutput += data.toString(); });
    serverProcess.stdout.on("data", (data) => { serverOutput += data.toString(); });

    // Wait for server to be ready (with cancellation guard)
    let cancelled = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cancelled = true;
        reject(new Error(`Server failed to start:\n${serverOutput}`));
      }, 15000);
      const check = async () => {
        if (cancelled) return;
        try {
          const response = await fetch(`${BASE_URL}/sessions`);
          if (response.ok) { clearTimeout(timeout); resolve(); }
          else if (!cancelled) setTimeout(check, 100);
        } catch {
          if (!cancelled) setTimeout(check, 100);
        }
      };
      check();
    });
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => serverProcess.on("exit", resolve));
    }
    if (daemonProcess) {
      daemonProcess.kill("SIGTERM");
      await new Promise((resolve) => daemonProcess.on("exit", resolve));
    }
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  // --- Create ---

  it("POST /sessions creates a new session and returns 201", async () => {
    const { status, body } = await request("POST", "/sessions", { name: "test-create" });
    assert.equal(status, 201, `Expected 201 Created, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.name, "test-create");

    // Cleanup
    await request("DELETE", "/sessions/test-create");
  });

  it("POST /sessions returns 409 for duplicate name", async () => {
    // Setup: ensure session exists
    await request("POST", "/sessions", { name: "dup-test" });

    const { status } = await request("POST", "/sessions", { name: "dup-test" });
    assert.equal(status, 409);

    // Cleanup
    await request("DELETE", "/sessions/dup-test");
  });

  it("POST /sessions returns 400 for empty name", async () => {
    const { status, body } = await request("POST", "/sessions", { name: "" });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("POST /sessions returns 400 for invalid characters only", async () => {
    const { status } = await request("POST", "/sessions", { name: "!!!" });
    assert.equal(status, 400);
  });

  it("POST /sessions sanitizes name (strips invalid chars)", async () => {
    const { status, body } = await request("POST", "/sessions", { name: "hello world!" });
    assert.equal(status, 201);
    assert.equal(body.name, "helloworld");

    // Cleanup using the name returned by the server
    await request("DELETE", `/sessions/${encodeURIComponent(body.name)}`);
  });

  // --- List ---

  it("GET /sessions lists created sessions", async () => {
    // Setup
    await request("POST", "/sessions", { name: "list-test" });

    const { status, body } = await request("GET", "/sessions");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    const names = body.map((s) => s.name);
    assert.ok(names.includes("list-test"), `Expected list-test in ${JSON.stringify(names)}`);

    // Cleanup
    await request("DELETE", "/sessions/list-test");
  });

  it("GET /sessions returns alive and pid for each session", async () => {
    // Setup
    await request("POST", "/sessions", { name: "fields-test" });

    const { body } = await request("GET", "/sessions");
    const session = body.find((s) => s.name === "fields-test");
    assert.ok(session, "fields-test should exist in session list");
    assert.equal(typeof session.pid, "number");
    assert.equal(typeof session.alive, "boolean");

    // Cleanup
    await request("DELETE", "/sessions/fields-test");
  });

  // --- Rename ---

  it("PUT /sessions/:name renames a session", async () => {
    // Setup
    await request("POST", "/sessions", { name: "rename-src" });

    const { status, body } = await request("PUT", "/sessions/rename-src", { name: "rename-dst" });
    assert.equal(status, 200);
    assert.equal(body.name, "rename-dst");

    // Verify it appears under new name
    const list = await request("GET", "/sessions");
    const names = list.body.map((s) => s.name);
    assert.ok(names.includes("rename-dst"));
    assert.ok(!names.includes("rename-src"));

    // Cleanup
    await request("DELETE", "/sessions/rename-dst");
  });

  it("PUT /sessions/:name returns 404 for nonexistent session", async () => {
    const { status } = await request("PUT", "/sessions/nonexistent-xyz", { name: "whatever" });
    assert.equal(status, 404);
  });

  it("PUT /sessions/:name returns 400 for invalid new name", async () => {
    // Setup
    await request("POST", "/sessions", { name: "rename-invalid" });

    const { status } = await request("PUT", "/sessions/rename-invalid", { name: "" });
    assert.equal(status, 400);

    // Cleanup
    await request("DELETE", "/sessions/rename-invalid");
  });

  // --- Delete ---

  it("DELETE /sessions/:name deletes a session", async () => {
    // Setup
    await request("POST", "/sessions", { name: "delete-test" });

    const { status, body } = await request("DELETE", "/sessions/delete-test");
    assert.equal(status, 200);
    assert.ok(body.ok);

    // Verify it's gone
    const list = await request("GET", "/sessions");
    const names = list.body.map((s) => s.name);
    assert.ok(!names.includes("delete-test"));
  });

  it("DELETE /sessions/:name returns 404 for nonexistent session", async () => {
    const { status } = await request("DELETE", "/sessions/nonexistent-xyz");
    assert.equal(status, 404);
  });

  // --- Full lifecycle (mirrors what the UI "+ New" button does) ---

  it("full lifecycle: create → list → rename → delete", async () => {
    // 1. Create (same as clicking "+ New" in session panel)
    const create = await request("POST", "/sessions", { name: "lifecycle-sess" });
    assert.equal(create.status, 201, "create should return 201");
    assert.equal(create.body.name, "lifecycle-sess");

    // 2. List (session panel refreshes after create)
    const list1 = await request("GET", "/sessions");
    assert.ok(
      list1.body.some((s) => s.name === "lifecycle-sess"),
      "new session should appear in list",
    );

    // 3. Rename
    const rename = await request("PUT", "/sessions/lifecycle-sess", { name: "lifecycle-renamed" });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.name, "lifecycle-renamed");

    // 4. Delete
    const del = await request("DELETE", "/sessions/lifecycle-renamed");
    assert.equal(del.status, 200);

    // 5. Verify gone
    const list2 = await request("GET", "/sessions");
    assert.ok(
      !list2.body.some((s) => s.name === "lifecycle-renamed"),
      "deleted session should not appear in list",
    );
  });
});
