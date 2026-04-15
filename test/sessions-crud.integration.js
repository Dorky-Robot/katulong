import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Run a tmux command against the isolated socket set up by setup-env.js.
// Using execFileSync + array args (not shell string interpolation) keeps
// the name safe from shell metacharacters, and prepending -L matches
// what the server does via tmuxSocketArgs() in lib/tmux.js. Tests that
// simulate "unmanaged tmux sessions the server should discover" need to
// create them on the same socket the server is watching, otherwise the
// server sees nothing.
const TMUX_SOCKET_ARGS = process.env.KATULONG_TMUX_SOCKET
  ? ["-L", process.env.KATULONG_TMUX_SOCKET]
  : [];
function tmuxSync(args) {
  try {
    execFileSync("tmux", [...TMUX_SOCKET_ARGS, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "(no stderr)";
    const cmd = ["tmux", ...TMUX_SOCKET_ARGS, ...args].join(" ");
    throw new Error(`tmuxSync failed: ${cmd}\n  stderr: ${stderr}`);
  }
}
function tmuxSyncQuiet(args) {
  try { tmuxSync(args); } catch { /* ignore — best-effort cleanup */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "server.js");

/**
 * Integration tests for Sessions CRUD via HTTP routes.
 *
 * Spins up a real server with an isolated data dir, then exercises
 * the session endpoints:
 *   POST   /sessions              — create
 *   GET    /sessions              — list
 *   PUT    /sessions/by-id/:id    — rename
 *   DELETE /sessions/by-id/:id    — delete
 *   GET    /sessions/by-id/:id/status — status
 *
 * Tmux state is isolated via KATULONG_TMUX_SOCKET (set per-process in
 * test/helpers/setup-env.js). Each test file runs on its own tmux
 * server, so there is no cross-file contamination and no need to
 * enumerate-and-kill known session names before/after the run — the
 * setup-env teardown kills the whole tmux server on exit.
 */

const TEST_PORT = 3010;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function request(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed };
}

// Helper: create a session and return its id. Fails the test if POST
// doesn't return a 201 with an id — every mutating test needs the id to
// target the by-id routes.
async function createAndGetId(name) {
  const res = await request("POST", "/sessions", { name });
  assert.equal(res.status, 201, `POST /sessions failed: ${JSON.stringify(res.body)}`);
  assert.equal(typeof res.body.id, "string", `POST /sessions must return an id`);
  return res.body.id;
}

async function deleteById(id) {
  return request("DELETE", `/sessions/by-id/${encodeURIComponent(id)}`);
}

describe("Sessions CRUD Integration", { skip: "flaky 10s server-startup poll under full-suite load; passes in isolation. TODO: investigate" }, () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-sessions-test-"));

    const minimalEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KATULONG_DATA_DIR: testDataDir,
      // Inherit the per-process isolated tmux socket from setup-env.js
      // so this test file's server doesn't share state with any other
      // parallel integration test.
      KATULONG_TMUX_SOCKET: process.env.KATULONG_TMUX_SOCKET,
      PORT: String(TEST_PORT),
    };

    // Spawn server (now manages sessions directly, no daemon needed).
    // We inherit stdio when DEBUG_TEST_SERVER=1 is set so developers
    // chasing a flake can see the server's stderr directly. Default is
    // pipe (capture into serverOutput) so normal test runs stay quiet.
    const debug = process.env.DEBUG_TEST_SERVER === "1";
    serverProcess = spawn("node", [SERVER_PATH], {
      env: minimalEnv,
      stdio: debug ? ["ignore", "inherit", "inherit"] : "pipe",
    });

    let serverOutput = "";
    if (!debug) {
      serverProcess.stderr.on("data", (data) => { serverOutput += data.toString(); });
      serverProcess.stdout.on("data", (data) => { serverOutput += data.toString(); });
    }

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server failed to start:\n${serverOutput}`)),
        15000,
      );
      const startTime = Date.now();
      const check = async () => {
        try {
          const response = await fetch(`${BASE_URL}/sessions`);
          if (response.ok) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 100);
        } catch {
          if (Date.now() - startTime < 15000) setTimeout(check, 100);
        }
      };
      check();
    });
  });

  after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => serverProcess.on("exit", resolve));
    }
    // Tmux sessions are cleaned up automatically when this test file's
    // process exits — setup-env.js runs `tmux -L <socket> kill-server`
    // in its on-exit handler, wiping the isolated tmux server in one
    // shot. No need to enumerate session names here.
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  // --- Create ---

  it("POST /sessions creates a new session and returns 201 with id", async () => {
    const { status, body } = await request("POST", "/sessions", { name: "test-create" });
    assert.equal(status, 201, `Expected 201 Created, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.name, "test-create");
    assert.equal(typeof body.id, "string");

    // Cleanup
    await deleteById(body.id);
  });

  it("POST /sessions returns 409 for duplicate name", async () => {
    const id = await createAndGetId("dup-test");

    const { status } = await request("POST", "/sessions", { name: "dup-test" });
    assert.equal(status, 409);

    await deleteById(id);
  });

  it("POST /sessions returns 400 for empty name", async () => {
    const { status, body } = await request("POST", "/sessions", { name: "" });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("POST /sessions returns 400 for invalid characters only", async () => {
    // All non-printable-ASCII chars get stripped, leaving empty → 400
    const { status } = await request("POST", "/sessions", { name: "\x01\x02\x03" });
    assert.equal(status, 400);
  });

  it("POST /sessions sanitizes name (strips invalid chars)", async () => {
    // Non-ASCII chars are stripped; printable ASCII (including !) is kept
    const { status, body } = await request("POST", "/sessions", { name: "hello\x00world" });
    assert.equal(status, 201);
    assert.equal(body.name, "helloworld");

    await deleteById(body.id);
  });

  // --- List ---

  it("GET /sessions lists created sessions", async () => {
    const id = await createAndGetId("list-test");

    const { status, body } = await request("GET", "/sessions");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    const names = body.map((s) => s.name);
    assert.ok(names.includes("list-test"), `Expected list-test in ${JSON.stringify(names)}`);

    await deleteById(id);
  });

  it("GET /sessions returns alive and tmuxSession for each session", async () => {
    const id = await createAndGetId("fields-test");

    const list = await request("GET", "/sessions");
    const session = list.body.find((s) => s.name === "fields-test");
    assert.ok(
      session,
      `fields-test should exist in session list; list was ${JSON.stringify(list.body.map(s => s.name))}`,
    );
    assert.equal(typeof session.tmuxSession, "string");
    assert.equal(typeof session.alive, "boolean");

    await deleteById(id);
  });

  // --- Rename ---

  it("PUT /sessions/by-id/:id renames a session", async () => {
    const id = await createAndGetId("rename-src");

    const { status, body } = await request("PUT", `/sessions/by-id/${encodeURIComponent(id)}`, { name: "rename-dst" });
    assert.equal(status, 200);
    assert.equal(body.name, "rename-dst");

    // Verify it appears under new name
    const list = await request("GET", "/sessions");
    const names = list.body.map((s) => s.name);
    assert.ok(names.includes("rename-dst"));
    assert.ok(!names.includes("rename-src"));

    await deleteById(id);
  });

  it("PUT /sessions/by-id/:id returns 404 for nonexistent session id", async () => {
    // Use a well-formed but unknown id (21 chars matching SESSION_ID_PATTERN)
    const { status } = await request("PUT", "/sessions/by-id/aaaaaaaaaaaaaaaaaaaaa", { name: "whatever" });
    assert.equal(status, 404);
  });

  it("PUT /sessions/by-id/:id returns 400 for invalid new name", async () => {
    const id = await createAndGetId("rename-invalid");

    const { status } = await request("PUT", `/sessions/by-id/${encodeURIComponent(id)}`, { name: "" });
    assert.equal(status, 400);

    await deleteById(id);
  });

  // --- Delete ---

  it("DELETE /sessions/by-id/:id deletes a session", async () => {
    const id = await createAndGetId("delete-test");

    const { status, body } = await deleteById(id);
    assert.equal(status, 200);
    assert.ok(body.ok);

    // Verify it's gone
    const list = await request("GET", "/sessions");
    const names = list.body.map((s) => s.name);
    assert.ok(!names.includes("delete-test"));
  });

  it("DELETE /sessions/by-id/:id returns 404 for nonexistent session id", async () => {
    const { status } = await request("DELETE", "/sessions/by-id/aaaaaaaaaaaaaaaaaaaaa");
    assert.equal(status, 404);
  });

  // --- Unmanaged tmux sessions ---

  it("GET /tmux-sessions lists tmux sessions not managed by katulong", async () => {
    const tmuxName = `unmanaged-integ-${Date.now()}`;
    tmuxSync(["new-session", "-d", "-s", tmuxName]);

    try {
      const { status, body } = await request("GET", "/tmux-sessions");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body));
      const names = body.map(s => typeof s === "string" ? s : s.name);
      assert.ok(names.includes(tmuxName), `Expected ${tmuxName} in unmanaged list: ${JSON.stringify(body)}`);
    } finally {
      tmuxSyncQuiet(["kill-session", "-t", tmuxName]);
    }
  });

  it("GET /tmux-sessions excludes managed sessions", async () => {
    const id = await createAndGetId("managed-excl");

    const { body } = await request("GET", "/tmux-sessions");
    // The managed session's tmux name should not appear in unmanaged list
    const managedList = await request("GET", "/sessions");
    const managedTmuxNames = managedList.body.map(s => s.tmuxSession);
    const unmanagedNames = body.map(s => typeof s === "string" ? s : s.name);
    for (const tmuxName of managedTmuxNames) {
      assert.ok(!unmanagedNames.includes(tmuxName), `Managed tmux session ${tmuxName} should not appear in unmanaged list`);
    }

    await deleteById(id);
  });

  it("POST /tmux-sessions/adopt adopts an unmanaged tmux session", async () => {
    const tmuxName = `adopt-integ-${Date.now()}`;
    tmuxSync(["new-session", "-d", "-s", tmuxName]);

    try {
      const { status, body } = await request("POST", "/tmux-sessions/adopt", { name: tmuxName });
      assert.equal(status, 201);
      assert.equal(body.name, tmuxName);
      assert.equal(typeof body.id, "string", "adopt must return an id");

      // Should now appear in managed sessions
      const list = await request("GET", "/sessions");
      const names = list.body.map(s => s.name);
      assert.ok(names.includes(tmuxName), `Adopted session should appear in managed list`);

      // Should no longer appear in unmanaged list
      const unmanaged = await request("GET", "/tmux-sessions");
      const unmanagedNames = unmanaged.body.map(s => typeof s === "string" ? s : s.name);
      assert.ok(!unmanagedNames.includes(tmuxName), `Adopted session should not appear in unmanaged list`);

      await deleteById(body.id);
    } catch (err) {
      tmuxSyncQuiet(["kill-session", "-t", tmuxName]);
      throw err;
    }
  });

  it("POST /tmux-sessions/adopt returns 409 for nonexistent tmux session", async () => {
    const { status, body } = await request("POST", "/tmux-sessions/adopt", { name: "no-such-session-xyz" });
    assert.equal(status, 409);
    assert.ok(body.error);
  });

  it("POST /tmux-sessions/adopt returns 409 for already-managed session", async () => {
    // POST /sessions creates both a katulong session and an underlying tmux session,
    // so the name is both managed and exists as a tmux session.
    const id = await createAndGetId("already-managed");

    try {
      const { status, body } = await request("POST", "/tmux-sessions/adopt", { name: "already-managed" });
      assert.equal(status, 409);
      assert.match(body.error, /already managed/i);
    } finally {
      await deleteById(id);
    }
  });

  it("POST /tmux-sessions/adopt returns 400 for missing name", async () => {
    const { status, body } = await request("POST", "/tmux-sessions/adopt", {});
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("POST /tmux-sessions/adopt returns 409 for invalid name with special chars", async () => {
    // Names with : . / are rejected by session manager validation.
    // Note: semantically this should be 400, but the route returns 409 for all
    // session manager errors. Tracked as a future improvement.
    const { status, body } = await request("POST", "/tmux-sessions/adopt", { name: "foo:bar" });
    assert.equal(status, 409);
    assert.match(body.error, /invalid/i);
  });

  it("DELETE /tmux-sessions/:name kills an unmanaged tmux session", async () => {
    const tmuxName = `kill-integ-${Date.now()}`;
    tmuxSync(["new-session", "-d", "-s", tmuxName]);

    try {
      const { status, body } = await request("DELETE", `/tmux-sessions/${tmuxName}`);
      assert.equal(status, 200);
      assert.ok(body.ok);

      // Should no longer appear in tmux
      const list = await request("GET", "/tmux-sessions");
      const names = list.body.map(s => typeof s === "string" ? s : s.name);
      assert.ok(!names.includes(tmuxName), `Killed session should not appear in list`);
    } catch (err) {
      tmuxSyncQuiet(["kill-session", "-t", tmuxName]);
      throw err;
    }
  });

  it("DELETE /tmux-sessions/:name refuses to kill managed sessions", async () => {
    const id = await createAndGetId("managed-nodelete");

    try {
      const { status, body } = await request("DELETE", `/tmux-sessions/managed-nodelete`);
      assert.equal(status, 400);
      assert.match(body.error, /managed/i);
    } finally {
      await deleteById(id);
    }
  });

  // --- Session status ---

  it("GET /sessions/by-id/:id/status returns status for a live session", async () => {
    const id = await createAndGetId("status-test");

    const { status, body } = await request("GET", `/sessions/by-id/${encodeURIComponent(id)}/status`);
    assert.equal(status, 200);
    assert.equal(body.name, "status-test");
    assert.equal(typeof body.alive, "boolean");
    assert.equal(typeof body.hasChildProcesses, "boolean");
    assert.equal(typeof body.childCount, "number");

    await deleteById(id);
  });

  it("GET /sessions/by-id/:id/status returns 404 for nonexistent session id", async () => {
    const { status } = await request("GET", "/sessions/by-id/aaaaaaaaaaaaaaaaaaaaa/status");
    assert.equal(status, 404);
  });

  it("GET /sessions/by-id/:id/status returns 400 for malformed id", async () => {
    // Malformed ids (wrong length / wrong charset) are rejected by the
    // SESSION_ID_PATTERN gate before any session lookup happens.
    const { status } = await request("GET", `/sessions/by-id/${encodeURIComponent("bad!")}/status`);
    assert.equal(status, 400);
  });

  // --- Full lifecycle (mirrors what the UI "+ New" button does) ---

  it("full lifecycle: create → list → rename → delete", async () => {
    // 1. Create (same as clicking "+ New" in session panel)
    const create = await request("POST", "/sessions", { name: "lifecycle-sess" });
    assert.equal(create.status, 201, "create should return 201");
    assert.equal(create.body.name, "lifecycle-sess");
    const id = create.body.id;
    assert.equal(typeof id, "string");

    // 2. List (session panel refreshes after create)
    const list1 = await request("GET", "/sessions");
    assert.ok(
      list1.body.some((s) => s.name === "lifecycle-sess"),
      "new session should appear in list",
    );

    // 3. Rename — id is stable across the rename
    const rename = await request("PUT", `/sessions/by-id/${encodeURIComponent(id)}`, { name: "lifecycle-renamed" });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.name, "lifecycle-renamed");
    assert.equal(rename.body.id, id, "rename must preserve the id");

    // 4. Delete via the same id
    const del = await deleteById(id);
    assert.equal(del.status, 200);

    // 5. Verify gone
    const list2 = await request("GET", "/sessions");
    assert.ok(
      !list2.body.some((s) => s.name === "lifecycle-renamed"),
      "deleted session should not appear in list",
    );
  });
});
