import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "server.js");

/**
 * Integration tests for POST /sessions/:name/input — the HTTP route powering
 * `katulong session send`. Mirrors the spawn-real-server pattern from
 * sessions-crud.integration.js so the tests exercise the actual auth +
 * session-manager wiring rather than mocks.
 *
 * Localhost requests bypass auth, which is the same surface every other
 * session route relies on; remote (non-loopback) auth is enforced by the
 * shared `auth(...)` middleware wrapping the route, not by per-route logic,
 * so we don't re-test it here.
 */

const TEST_PORT = 3014;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function request(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const init = { method, headers };
  if (body !== undefined) {
    if (typeof body === "string") {
      init.body = body;
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed };
}

describe("POST /sessions/:name/input integration", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-input-test-"));
    const minimalEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KATULONG_DATA_DIR: testDataDir,
      KATULONG_TMUX_SOCKET: process.env.KATULONG_TMUX_SOCKET,
      PORT: String(TEST_PORT),
    };
    const debug = process.env.DEBUG_TEST_SERVER === "1";
    serverProcess = spawn("node", [SERVER_PATH], {
      env: minimalEnv,
      stdio: debug ? ["ignore", "inherit", "inherit"] : "pipe",
    });
    let serverOutput = "";
    if (!debug) {
      serverProcess.stderr.on("data", (d) => { serverOutput += d.toString(); });
      serverProcess.stdout.on("data", (d) => { serverOutput += d.toString(); });
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server failed to start:\n${serverOutput}`)),
        15000,
      );
      const start = Date.now();
      const check = async () => {
        try {
          const r = await fetch(`${BASE_URL}/sessions`);
          if (r.ok) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 100);
        } catch {
          if (Date.now() - start < 15000) setTimeout(check, 100);
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
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  it("returns 404 for unknown session", async () => {
    const { status, body } = await request("POST", "/sessions/no-such-xyz/input", { data: "hello" });
    assert.equal(status, 404);
    assert.ok(body.error);
  });

  it("returns 400 when data is missing", async () => {
    await request("POST", "/sessions", { name: "input-missing" });
    try {
      const { status } = await request("POST", "/sessions/input-missing/input", {});
      assert.equal(status, 400);
    } finally {
      await request("DELETE", "/sessions/input-missing");
    }
  });

  it("returns 400 when data is not a string", async () => {
    await request("POST", "/sessions", { name: "input-nonstring" });
    try {
      const { status } = await request("POST", "/sessions/input-nonstring/input", { data: 123 });
      assert.equal(status, 400);
    } finally {
      await request("DELETE", "/sessions/input-nonstring");
    }
  });

  it("returns 400 when data is empty", async () => {
    await request("POST", "/sessions", { name: "input-empty" });
    try {
      const { status } = await request("POST", "/sessions/input-empty/input", { data: "" });
      assert.equal(status, 400);
    } finally {
      await request("DELETE", "/sessions/input-empty");
    }
  });

  it("happy path: writes input and the bytes show up in session output", async () => {
    const create = await request("POST", "/sessions", { name: "input-happy" });
    assert.equal(create.status, 201);
    try {
      // Send a unique marker followed by Enter so the shell echoes it back.
      const marker = `katmarker_${Date.now()}`;
      const send = await request("POST", "/sessions/input-happy/input", { data: `echo ${marker}\r` });
      assert.equal(send.status, 200);
      assert.equal(send.body.ok, true);
      assert.equal(typeof send.body.bytes, "number");
      assert.ok(send.body.bytes >= marker.length);

      // Give the shell a moment to process the keystroke and emit output.
      await new Promise((r) => setTimeout(r, 600));

      const out = await request("GET", "/sessions/input-happy/output");
      assert.equal(out.status, 200);
      const text = typeof out.body?.data === "string" ? out.body.data : "";
      assert.ok(
        text.includes(marker),
        `Expected marker "${marker}" in output, got: ${JSON.stringify(text).slice(0, 300)}`,
      );
    } finally {
      await request("DELETE", "/sessions/input-happy");
    }
  });

  it("rejects bodies exceeding 1MB", async () => {
    const create = await request("POST", "/sessions", { name: "input-big" });
    assert.equal(create.status, 201);
    try {
      // 1.1MB of "a" inside a JSON string trips parseJSON's default cap.
      // readBody() destroys the request on overflow, so the server drops the
      // connection mid-upload rather than sending a 413. Either outcome (a
      // connection reset OR a non-2xx response) is acceptable — what matters
      // is that the oversized payload is not accepted.
      const huge = "a".repeat(1.1 * 1024 * 1024);
      let accepted = false;
      try {
        const { status } = await request(
          "POST",
          "/sessions/input-big/input",
          JSON.stringify({ data: huge }),
        );
        accepted = status >= 200 && status < 300;
      } catch {
        // fetch threw (ECONNRESET) — server dropped the oversized upload.
      }
      assert.equal(accepted, false, "oversized body must not be accepted");
    } finally {
      await request("DELETE", "/sessions/input-big");
    }
  });
});
