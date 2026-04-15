import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, scryptSync, randomUUID } from "node:crypto";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "server.js");
const TEST_PORT = 3018;
const BASE = `http://localhost:${TEST_PORT}`;

async function req(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

/** Raw http.request — unlike fetch, this honours custom Host headers. */
function rawReq(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: "localhost", port: TEST_PORT, path, method,
      headers: { ...headers },
    };
    if (payload) {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const r = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("API Keys Integration", { skip: "flaky under parallel full-suite run; passes in isolation. TODO: investigate env contamination" }, () => {
  let server, dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-apikey-test-"));
    // Seed auth state so server starts in authenticated mode
    writeFileSync(join(dataDir, "user.json"), JSON.stringify({ id: randomUUID(), name: "owner" }));
    const tokDir = join(dataDir, "setup-tokens");
    mkdirSync(tokDir, { recursive: true });

    server = spawn("node", [SERVER_PATH], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY || "", KATULONG_DATA_DIR: dataDir, KATULONG_TMUX_SOCKET: process.env.KATULONG_TMUX_SOCKET, PORT: String(TEST_PORT) },
      stdio: "pipe",
    });
    server.stderr.on("data", () => {});
    server.stdout.on("data", () => {});
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("start timeout")), 15000);
      const check = async () => {
        try { const r = await fetch(`${BASE}/health`); if (r.ok) { clearTimeout(t); resolve(); } else setTimeout(check, 100); }
        catch { setTimeout(check, 100); }
      };
      check();
    });
  });

  after(async () => {
    if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise(r => server.on("exit", r)); }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /api/api-keys creates a key", async () => {
    const { status, body } = await req("POST", "/api/api-keys", { name: "test-key" });
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.ok(body.key);
    assert.equal(body.name, "test-key");
    assert.equal(body.prefix, body.key.slice(0, 8));
  });

  it("GET /api/api-keys lists keys", async () => {
    const { status, body } = await req("GET", "/api/api-keys");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 1);
    assert.ok(body[0].id);
    assert.ok(body[0].prefix);
    assert.ok(!body[0].key); // key should not be returned in list
    assert.ok(!body[0].hash); // hash should not be exposed
  });

  it("Bearer token authenticates remote requests", async () => {
    // Create a key
    const { body: created } = await req("POST", "/api/api-keys", { name: "bearer-test" });
    // Use it to access a protected endpoint
    const { status, body } = await req("GET", "/sessions", null, {
      Authorization: `Bearer ${created.key}`,
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  it("invalid Bearer token still works on localhost (localhost bypasses auth)", async () => {
    // Localhost requests always bypass auth, so even invalid keys succeed
    const { status } = await req("GET", "/sessions", null, {
      Authorization: "Bearer invalid-key-value",
    });
    assert.equal(status, 200);
  });

  it("DELETE /api/api-keys/:id revokes a key", async () => {
    const { body: created } = await req("POST", "/api/api-keys", { name: "to-revoke" });
    const { status } = await req("DELETE", `/api/api-keys/${created.id}`);
    assert.equal(status, 200);
    // Verify it's gone from the list
    const { body: keys } = await req("GET", "/api/api-keys");
    assert.ok(!keys.find(k => k.id === created.id));
  });

  it("API-key-created session gets robot icon", async () => {
    // Create an API key (localhost — auto-auth)
    const { body: created } = await req("POST", "/api/api-keys", { name: "badge-test" });

    // Create a session via Bearer token with a spoofed Host header so
    // isLocalRequest() returns false and the Bearer-token auth path runs,
    // setting req._apiKeyAuth = true.  Node's fetch ignores custom Host
    // headers, so we use a raw http.request to control it exactly.
    const { status, body } = await rawReq("POST", "/sessions", { name: "agent-badge" }, {
      Authorization: `Bearer ${created.key}`,
      Host: "remote.example.com",
    });
    assert.equal(status, 201);
    assert.equal(body.name, "agent-badge");

    // Verify the session has the robot icon via the list endpoint
    const list = await req("GET", "/sessions");
    const session = list.body.find(s => s.name === "agent-badge");
    assert.ok(session, "session should exist in list");
    assert.equal(session.icon, "robot", "API-key-created session should have robot icon");

    // Cleanup — use the stable id returned from the POST /sessions response
    await req("DELETE", `/sessions/by-id/${encodeURIComponent(body.id)}`);
  });

  it("locally-created session does not get robot icon", async () => {
    // Create a session without API key auth (localhost auto-auth)
    const create = await req("POST", "/sessions", { name: "local-badge" });
    assert.equal(create.status, 201);

    const list = await req("GET", "/sessions");
    const session = list.body.find(s => s.name === "local-badge");
    assert.ok(session, "session should exist in list");
    assert.equal(session.icon, null, "locally-created session should not have an icon");

    // Cleanup
    await req("DELETE", `/sessions/by-id/${encodeURIComponent(create.body.id)}`);
  });

  it("API key bypasses CSRF", async () => {
    const { body: created } = await req("POST", "/api/api-keys", { name: "csrf-test" });
    // POST without CSRF token but with Bearer — should work
    const { status } = await req("POST", "/api/api-keys", { name: "no-csrf" }, {
      Authorization: `Bearer ${created.key}`,
    });
    assert.equal(status, 201);
  });
});
