/**
 * Integration tests for information disclosure vulnerabilities:
 * - GET /shortcuts and GET /sessions must require authentication
 * - POST /upload must return a relative URL path, not an absolute filesystem path
 *
 * To simulate an unauthenticated remote (non-localhost) request without running a
 * full tunnel, we connect from loopback but set the Host header to a non-local
 * domain.  `isLocalRequest()` checks both socket address AND Host/Origin headers,
 * so a loopback socket with Host: example.ngrok.app is treated as an internet
 * request and therefore requires a session cookie.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const TEST_PORT = 3005;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Minimal valid PNG header (8-byte signature + IHDR chunk stub)
const PNG_BUF = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d,                           // IHDR length
  0x49, 0x48, 0x44, 0x52,                           // "IHDR"
  0x00, 0x00, 0x00, 0x01,                           // width = 1
  0x00, 0x00, 0x00, 0x01,                           // height = 1
  0x08, 0x02,                                        // bit depth, colour type
  0x00, 0x00, 0x00,                                 // compression, filter, interlace
]);

/**
 * Low-level HTTP request that does NOT follow redirects and allows arbitrary
 * headers (including Host), which the fetch API forbids.
 */
function rawRequest({ method = "GET", path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: TEST_PORT, method, path, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Simulate an unauthenticated request from a remote (non-localhost) client. */
function remoteRequest(method, path, body) {
  return rawRequest({
    method,
    path,
    // Non-local Host causes isLocalRequest() to return false → auth is enforced
    headers: { host: "example.ngrok.app" },
    body,
  });
}

/** Simulate an authenticated request from localhost (auth auto-bypassed). */
function localRequest(method, path, headers = {}, body) {
  return rawRequest({
    method,
    path,
    headers: { host: `localhost:${TEST_PORT}`, ...headers },
    body,
  });
}

describe("Info-disclosure security (#151, #126)", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-info-disclosure-"));

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SSH_PORT: String(TEST_PORT + 10),
        KATULONG_DATA_DIR: testDataDir,
        // No KATULONG_NO_AUTH — we want real auth enforcement
      },
      stdio: "pipe",
    });

    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[test server] exited with code ${code}\n`);
      }
    });

    // Wait until the server responds to /auth/status
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Server did not start in time")), 10000);
      function poll() {
        rawRequest({ path: "/auth/status" })
          .then(() => { clearTimeout(deadline); resolve(); })
          .catch(() => setTimeout(poll, 100));
      }
      poll();
    });
  });

  after(() => {
    serverProcess?.kill();
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // GET /shortcuts — auth required
  // ---------------------------------------------------------------------------

  describe("GET /shortcuts", () => {
    it("rejects unauthenticated remote request (not 200)", async () => {
      const res = await remoteRequest("GET", "/shortcuts");
      assert.notEqual(res.status, 200, "unauthenticated remote request must not return data");
    });

    it("unauthenticated remote request returns 302 or 401", async () => {
      const res = await remoteRequest("GET", "/shortcuts");
      assert.ok(
        res.status === 302 || res.status === 401,
        `expected 302 or 401, got ${res.status}`
      );
    });

    it("authenticated localhost request is not rejected with 401", async () => {
      const res = await localRequest("GET", "/shortcuts");
      // Daemon is not running, so expect 503 or similar — but NOT 401 (auth bypass works)
      assert.notEqual(res.status, 401, "localhost requests should bypass auth");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /sessions — auth required
  // ---------------------------------------------------------------------------

  describe("GET /sessions", () => {
    it("rejects unauthenticated remote request (not 200)", async () => {
      const res = await remoteRequest("GET", "/sessions");
      assert.notEqual(res.status, 200, "unauthenticated remote request must not return data");
    });

    it("unauthenticated remote request returns 302 or 401", async () => {
      const res = await remoteRequest("GET", "/sessions");
      assert.ok(
        res.status === 302 || res.status === 401,
        `expected 302 or 401, got ${res.status}`
      );
    });

    it("authenticated localhost request is not rejected with 401", async () => {
      const res = await localRequest("GET", "/sessions");
      assert.notEqual(res.status, 401, "localhost requests should bypass auth");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /upload — path must be relative
  // ---------------------------------------------------------------------------

  describe("POST /upload", () => {
    it("rejects unauthenticated remote request", async () => {
      const res = await remoteRequest("POST", "/upload", PNG_BUF);
      assert.notEqual(res.status, 200, "unauthenticated remote request must not succeed");
    });

    it("returns a relative URL path, not an absolute filesystem path", async () => {
      const res = await localRequest(
        "POST",
        "/upload",
        { "content-type": "application/octet-stream" },
        PNG_BUF,
      );
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
      assert.ok(res.json, "response should be JSON");

      const { path } = res.json;
      assert.ok(typeof path === "string", "response.path should be a string");
      assert.ok(
        path.startsWith("/uploads/"),
        `path should start with /uploads/, got: ${path}`
      );
      // Must NOT be an absolute filesystem path
      assert.ok(
        !path.startsWith("/home/") &&
        !path.startsWith("/tmp/") &&
        !path.startsWith("/root/") &&
        !path.startsWith("/var/") &&
        !path.startsWith("/usr/"),
        `path must not be an absolute filesystem path, got: ${path}`
      );
      // Must not contain the data directory
      assert.ok(
        !path.includes(testDataDir),
        `path must not expose the data directory, got: ${path}`
      );
    });

    it("returned path matches /uploads/<uuid>.<ext> format", async () => {
      const res = await localRequest(
        "POST",
        "/upload",
        { "content-type": "application/octet-stream" },
        PNG_BUF,
      );
      assert.equal(res.status, 200);
      const { path } = res.json;
      assert.match(
        path,
        /^\/uploads\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/,
        `path should match /uploads/<uuid>.<ext>, got: ${path}`
      );
    });
  });
});
