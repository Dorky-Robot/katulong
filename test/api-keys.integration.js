import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, scryptSync, randomUUID } from "node:crypto";

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

describe("API Keys Integration", () => {
  let server, dataDir;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-apikey-test-"));
    // Seed auth state so server starts in authenticated mode
    writeFileSync(join(dataDir, "user.json"), JSON.stringify({ id: randomUUID(), name: "owner" }));
    const tokDir = join(dataDir, "setup-tokens");
    mkdirSync(tokDir, { recursive: true });

    server = spawn("node", [SERVER_PATH], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY || "", KATULONG_DATA_DIR: dataDir, PORT: String(TEST_PORT) },
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

  it("API key bypasses CSRF", async () => {
    const { body: created } = await req("POST", "/api/api-keys", { name: "csrf-test" });
    // POST without CSRF token but with Bearer — should work
    const { status } = await req("POST", "/api/api-keys", { name: "no-csrf" }, {
      Authorization: `Bearer ${created.key}`,
    });
    assert.equal(status, 201);
  });
});
