/**
 * Integration tests for CSRF protection on PUT /api/config/* endpoints.
 *
 * These tests verify that non-localhost (remote) requests to the config
 * mutation endpoints are rejected with 403 if the CSRF token is missing
 * or invalid, even when the session cookie is valid.
 *
 * Technique: connect from loopback but set Host to a non-local domain.
 * isLocalRequest() checks both socket address AND Host/Origin headers, so
 * a loopback socket with Host: example.ngrok.app is treated as a remote
 * (internet) request and therefore requires CSRF validation.
 *
 * Closes #222
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const TEST_PORT = 3007;

// A pre-seeded session token and matching CSRF token used in tests.
const SESSION_TOKEN = "test-session-token-abcdef1234567890abcdef1234567890";
const CSRF_TOKEN = "a".repeat(64); // 64-char CSRF token
const CREDENTIAL_ID = "test-cred-id-abcdef";

/**
 * Build a katulong-auth.json state file with a single valid session.
 * The session has a known CSRF token so tests can set or omit it.
 */
function buildAuthState() {
  return {
    user: { id: "test-user-id", name: "Test User" },
    credentials: [
      {
        id: CREDENTIAL_ID,
        publicKey: Buffer.from("test-public-key").toString("base64url"),
        counter: 0,
        deviceId: "test-device-id",
        name: "Test Device",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        userAgent: "Test/1.0",
        transports: [],
      },
    ],
    sessions: {
      [SESSION_TOKEN]: {
        expiry: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days from now
        credentialId: CREDENTIAL_ID,
        csrfToken: CSRF_TOKEN,
        lastActivityAt: Date.now(),
      },
    },
    setupTokens: [],
  };
}

/**
 * Low-level HTTP request that allows custom Host header (fetch() forbids it).
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

/**
 * Simulate an authenticated remote request (non-localhost Host).
 * Omits the CSRF token header by default.
 */
function remoteRequest(method, path, { csrfToken, body } = {}) {
  return rawRequest({
    method,
    path,
    headers: {
      host: "example.ngrok.app",
      cookie: `katulong_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
      ...(csrfToken !== undefined ? { "x-csrf-token": csrfToken } : {}),
    },
    body,
  });
}

/**
 * Simulate an authenticated localhost request (auth + CSRF bypass).
 */
function localRequest(method, path, body) {
  return rawRequest({
    method,
    path,
    headers: {
      host: `localhost:${TEST_PORT}`,
      "content-type": "application/json",
    },
    body,
  });
}

// Minimal valid PNG header for upload tests
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
 * Authenticated remote request that sends binary body (for upload tests).
 */
function remoteUploadRequest({ csrfToken } = {}) {
  return rawRequest({
    method: "POST",
    path: "/upload",
    headers: {
      host: "example.ngrok.app",
      cookie: `katulong_session=${SESSION_TOKEN}`,
      "content-type": "application/octet-stream",
      ...(csrfToken !== undefined ? { "x-csrf-token": csrfToken } : {}),
    },
    body: PNG_BUF,
  });
}

describe("CSRF protection on PUT /api/config/* (#222)", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-config-csrf-"));

    // Pre-seed the auth state file with a valid session
    const authStatePath = join(testDataDir, "katulong-auth.json");
    writeFileSync(authStatePath, JSON.stringify(buildAuthState()), "utf-8");

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SSH_PORT: String(TEST_PORT + 10),
        KATULONG_DATA_DIR: testDataDir,
        // No KATULONG_NO_AUTH — real auth enforcement required
      },
      stdio: "pipe",
    });

    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[config-csrf test server] exited with code ${code}\n`);
      }
    });

    // Wait until the server is ready
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
  // PUT /api/config/instance-name
  // ---------------------------------------------------------------------------

  describe("PUT /api/config/instance-name", () => {
    it("rejects remote request without CSRF token with 403", async () => {
      const res = await remoteRequest("PUT", "/api/config/instance-name", {
        body: JSON.stringify({ instanceName: "Hacked Name" }),
      });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.error, "should return error message");
    });

    it("rejects remote request with wrong CSRF token with 403", async () => {
      const res = await remoteRequest("PUT", "/api/config/instance-name", {
        csrfToken: "b".repeat(64), // Wrong CSRF token
        body: JSON.stringify({ instanceName: "Hacked Name" }),
      });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
    });

    it("accepts remote request with valid CSRF token", async () => {
      const res = await remoteRequest("PUT", "/api/config/instance-name", {
        csrfToken: CSRF_TOKEN,
        body: JSON.stringify({ instanceName: "Remote Update" }),
      });
      assert.equal(res.status, 200, `expected 200 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.success, "should indicate success");
    });

    it("accepts localhost request without CSRF token", async () => {
      const res = await localRequest(
        "PUT",
        "/api/config/instance-name",
        JSON.stringify({ instanceName: "Local Update" })
      );
      assert.equal(res.status, 200, `localhost request should succeed without CSRF: ${res.body}`);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /api/config/instance-icon
  // ---------------------------------------------------------------------------

  describe("PUT /api/config/instance-icon", () => {
    it("rejects remote request without CSRF token with 403", async () => {
      const res = await remoteRequest("PUT", "/api/config/instance-icon", {
        body: JSON.stringify({ instanceIcon: "code" }),
      });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.error, "should return error message");
    });

    it("rejects remote request with wrong CSRF token with 403", async () => {
      const res = await remoteRequest("PUT", "/api/config/instance-icon", {
        csrfToken: "c".repeat(64),
        body: JSON.stringify({ instanceIcon: "code" }),
      });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
    });

    it("accepts remote request with valid CSRF token", async () => {
      const res = await remoteRequest("PUT", "/api/config/instance-icon", {
        csrfToken: CSRF_TOKEN,
        body: JSON.stringify({ instanceIcon: "code" }),
      });
      assert.equal(res.status, 200, `expected 200 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.success, "should indicate success");
    });

    it("accepts localhost request without CSRF token", async () => {
      const res = await localRequest(
        "PUT",
        "/api/config/instance-icon",
        JSON.stringify({ instanceIcon: "laptop" })
      );
      assert.equal(res.status, 200, `localhost request should succeed without CSRF: ${res.body}`);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /api/config/toolbar-color
  // ---------------------------------------------------------------------------

  describe("PUT /api/config/toolbar-color", () => {
    it("rejects remote request without CSRF token with 403", async () => {
      const res = await remoteRequest("PUT", "/api/config/toolbar-color", {
        body: JSON.stringify({ toolbarColor: "red" }),
      });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.error, "should return error message");
    });

    it("rejects remote request with wrong CSRF token with 403", async () => {
      const res = await remoteRequest("PUT", "/api/config/toolbar-color", {
        csrfToken: "d".repeat(64),
        body: JSON.stringify({ toolbarColor: "blue" }),
      });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
    });

    it("accepts remote request with valid CSRF token", async () => {
      const res = await remoteRequest("PUT", "/api/config/toolbar-color", {
        csrfToken: CSRF_TOKEN,
        body: JSON.stringify({ toolbarColor: "green" }),
      });
      assert.equal(res.status, 200, `expected 200 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.success, "should indicate success");
    });

    it("accepts localhost request without CSRF token", async () => {
      const res = await localRequest(
        "PUT",
        "/api/config/toolbar-color",
        JSON.stringify({ toolbarColor: "purple" })
      );
      assert.equal(res.status, 200, `localhost request should succeed without CSRF: ${res.body}`);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /upload — CSRF required for remote requests
  // ---------------------------------------------------------------------------

  describe("POST /upload", () => {
    it("rejects remote upload without CSRF token with 403", async () => {
      const res = await remoteUploadRequest();
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.error, "should return error message");
    });

    it("rejects remote upload with wrong CSRF token with 403", async () => {
      const res = await remoteUploadRequest({ csrfToken: "b".repeat(64) });
      assert.equal(res.status, 403, `expected 403 but got ${res.status}: ${res.body}`);
    });

    it("accepts remote upload with valid CSRF token", async () => {
      const res = await remoteUploadRequest({ csrfToken: CSRF_TOKEN });
      assert.equal(res.status, 200, `expected 200 but got ${res.status}: ${res.body}`);
      assert.ok(res.json?.path?.startsWith("/uploads/"), "should return upload path");
    });

    it("accepts localhost upload without CSRF token", async () => {
      const res = await rawRequest({
        method: "POST",
        path: "/upload",
        headers: {
          host: `localhost:${TEST_PORT}`,
          "content-type": "application/octet-stream",
        },
        body: PNG_BUF,
      });
      assert.equal(res.status, 200, `localhost upload should succeed without CSRF: ${res.body}`);
    });
  });
});
