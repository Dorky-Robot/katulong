import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration tests for Sessions CRUD via HTTP routes.
 *
 * Spins up a real server + daemon (via entrypoint.js) with an isolated
 * socket and data dir, then exercises the session endpoints the same way
 * the frontend session-manager.js does:
 *   POST   /sessions          — create
 *   GET    /sessions          — list
 *   PUT    /sessions/:name    — rename
 *   DELETE /sessions/:name    — delete
 */

const TEST_PORT = 3010;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function postJSON(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function putJSON(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function deleteReq(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "DELETE" });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getJSON(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, body: await res.json() };
}

describe("Sessions CRUD Integration", () => {
  let entrypointProcess;
  let testDataDir;
  const testSocket = `/tmp/katulong-test-sessions-${process.pid}.sock`;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-sessions-test-"));

    // Use entrypoint.js to start both daemon + server with isolated socket
    entrypointProcess = spawn("node", ["entrypoint.js"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SSH_PORT: String(TEST_PORT + 10),
        KATULONG_DATA_DIR: testDataDir,
        KATULONG_SOCK: testSocket,
        KATULONG_NO_AUTH: "1",
      },
      stdio: "pipe",
    });

    let serverOutput = "";
    entrypointProcess.stderr.on("data", (d) => { serverOutput += d.toString(); });
    entrypointProcess.stdout.on("data", (d) => { serverOutput += d.toString(); });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server failed to start:\n${serverOutput}`)),
        15000,
      );
      const check = async () => {
        try {
          const r = await fetch(`${BASE_URL}/sessions`);
          if (r.ok) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 100);
        } catch {
          setTimeout(check, 100);
        }
      };
      check();
    });
  });

  after(() => {
    if (entrypointProcess) entrypointProcess.kill();
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  // --- Create ---

  it("POST /sessions creates a new session and returns 201", async () => {
    const { status, body } = await postJSON("/sessions", { name: "test-create" });
    assert.equal(status, 201, `Expected 201 Created, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.name, "test-create");
  });

  it("POST /sessions returns 409 for duplicate name", async () => {
    const { status } = await postJSON("/sessions", { name: "test-create" });
    assert.equal(status, 409);
  });

  it("POST /sessions returns 400 for empty name", async () => {
    const { status, body } = await postJSON("/sessions", { name: "" });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("POST /sessions returns 400 for invalid characters only", async () => {
    const { status } = await postJSON("/sessions", { name: "!!!" });
    assert.equal(status, 400);
  });

  it("POST /sessions sanitizes name (strips invalid chars)", async () => {
    const { status, body } = await postJSON("/sessions", { name: "hello world!" });
    assert.equal(status, 201);
    assert.equal(body.name, "helloworld");

    // Cleanup
    await deleteReq("/sessions/helloworld");
  });

  // --- List ---

  it("GET /sessions lists created sessions", async () => {
    const { status, body } = await getJSON("/sessions");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    const names = body.map((s) => s.name);
    assert.ok(names.includes("test-create"), `Expected test-create in ${JSON.stringify(names)}`);
  });

  it("GET /sessions returns alive and pid for each session", async () => {
    const { body } = await getJSON("/sessions");
    const session = body.find((s) => s.name === "test-create");
    assert.ok(session, "test-create should exist");
    assert.equal(typeof session.pid, "number");
    assert.equal(typeof session.alive, "boolean");
  });

  // --- Rename ---

  it("PUT /sessions/:name renames a session", async () => {
    const { status, body } = await putJSON("/sessions/test-create", { name: "test-renamed" });
    assert.equal(status, 200);
    assert.equal(body.name, "test-renamed");

    // Verify it appears under new name
    const list = await getJSON("/sessions");
    const names = list.body.map((s) => s.name);
    assert.ok(names.includes("test-renamed"));
    assert.ok(!names.includes("test-create"));
  });

  it("PUT /sessions/:name returns 404 for nonexistent session", async () => {
    const { status } = await putJSON("/sessions/nonexistent-xyz", { name: "whatever" });
    assert.equal(status, 404);
  });

  it("PUT /sessions/:name returns 400 for invalid new name", async () => {
    const { status } = await putJSON("/sessions/test-renamed", { name: "" });
    assert.equal(status, 400);
  });

  // --- Delete ---

  it("DELETE /sessions/:name deletes a session", async () => {
    const { status, body } = await deleteReq("/sessions/test-renamed");
    assert.equal(status, 200);
    assert.ok(body.ok);

    // Verify it's gone
    const list = await getJSON("/sessions");
    const names = list.body.map((s) => s.name);
    assert.ok(!names.includes("test-renamed"));
  });

  it("DELETE /sessions/:name returns 404 for nonexistent session", async () => {
    const { status } = await deleteReq("/sessions/nonexistent-xyz");
    assert.equal(status, 404);
  });

  // --- Full lifecycle (mirrors what the UI "+ New" button does) ---

  it("full lifecycle: create → list → rename → delete", async () => {
    // 1. Create (same as clicking "+ New" in session panel)
    const create = await postJSON("/sessions", { name: "lifecycle-sess" });
    assert.equal(create.status, 201, "create should return 201");
    assert.equal(create.body.name, "lifecycle-sess");

    // 2. List (session panel refreshes after create)
    const list1 = await getJSON("/sessions");
    assert.ok(
      list1.body.some((s) => s.name === "lifecycle-sess"),
      "new session should appear in list",
    );

    // 3. Rename
    const rename = await putJSON("/sessions/lifecycle-sess", { name: "lifecycle-renamed" });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.name, "lifecycle-renamed");

    // 4. Delete
    const del = await deleteReq("/sessions/lifecycle-renamed");
    assert.equal(del.status, 200);

    // 5. Verify gone
    const list2 = await getJSON("/sessions");
    assert.ok(
      !list2.body.some((s) => s.name === "lifecycle-renamed"),
      "deleted session should not appear in list",
    );
  });
});
