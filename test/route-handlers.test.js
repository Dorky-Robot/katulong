/**
 * Integration tests for server.js HTTP route handlers.
 *
 * Tests cover:
 * - GET /api/tokens — returns list of setup tokens
 * - POST /api/tokens — creates a setup token, validates input
 * - DELETE /api/tokens/:id — removes a setup token by ID
 * - PATCH /api/tokens/:id — updates a setup token name
 * - GET /api/credentials — returns list of registered credentials/devices
 * - PUT /api/config/instance-icon — sets instance icon, validates input
 * - PUT /api/config/toolbar-color — sets toolbar color, validates input
 * - Auth enforcement (302 redirect for unauthenticated remote requests)
 * - Error handling (invalid JSON, missing fields, non-existent resources)
 *
 * Closes #145
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

// Port for main test server (KATULONG_NO_AUTH=1)
const TEST_PORT = 3008;
const TEST_SSH_PORT = 3048; // SSH port far from HTTP ports to avoid collisions
// Port for auth enforcement test server (no KATULONG_NO_AUTH)
const AUTH_TEST_PORT = 3028;
const AUTH_SSH_PORT = 3068;

/**
 * Low-level HTTP request builder. Allows setting custom Host headers
 * (which fetch() forbids) to simulate localhost vs. remote access.
 */
function rawRequest({ port = TEST_PORT, method = "GET", path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers },
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

/** Make a localhost-identified request (bypasses auth). */
function localRequest(port, method, path, body) {
  return rawRequest({
    port,
    method,
    path,
    headers: {
      "Content-Type": "application/json",
      "Host": `localhost:${port}`,
    },
    body,
  });
}

/** Make a remote-identified request (requires auth; no session = 302). */
function remoteRequest(port, method, path, body) {
  return rawRequest({
    port,
    method,
    path,
    headers: {
      "Content-Type": "application/json",
      "Host": "example.ngrok.app",
    },
    body,
  });
}

/** Wait for the server to accept connections on /health. */
function waitForServer(port) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Server on port ${port} did not start in time`)),
      10000
    );
    function poll() {
      rawRequest({ port, method: "GET", path: "/health", headers: { Host: `localhost:${port}` } })
        .then((res) => {
          if (res.status === 200) {
            clearTimeout(deadline);
            resolve();
          } else {
            setTimeout(poll, 100);
          }
        })
        .catch(() => setTimeout(poll, 100));
    }
    poll();
  });
}

// ---------------------------------------------------------------------------
// Main test suite — server with KATULONG_NO_AUTH=1 (all routes accessible)
// ---------------------------------------------------------------------------

describe("Route Handlers (KATULONG_NO_AUTH=1)", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-route-handlers-"));

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SSH_PORT: String(TEST_SSH_PORT),
        KATULONG_DATA_DIR: testDataDir,
        KATULONG_NO_AUTH: "1",
      },
      stdio: "pipe",
    });

    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[route-handlers server] exited with code ${code}\n`);
      }
    });

    await waitForServer(TEST_PORT);
  });

  after(() => {
    serverProcess?.kill();
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/tokens
  // -------------------------------------------------------------------------

  describe("GET /api/tokens", () => {
    it("returns empty token list when no tokens exist", async () => {
      const res = await localRequest(TEST_PORT, "GET", "/api/tokens");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json?.tokens), "should return tokens array");
      assert.equal(res.json.tokens.length, 0);
    });

    it("returns token list without plaintext token values", async () => {
      // Create a token first
      const createRes = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "List Test Token" })
      );
      assert.equal(createRes.status, 200);
      const tokenId = createRes.json.id;

      const listRes = await localRequest(TEST_PORT, "GET", "/api/tokens");
      assert.equal(listRes.status, 200);

      const found = listRes.json.tokens.find(t => t.id === tokenId);
      assert.ok(found, "created token should appear in list");
      assert.ok(found.name, "token should have name");
      assert.ok(found.id, "token should have id");
      assert.ok(found.createdAt, "token should have createdAt");
      // Plaintext token must NOT be returned in list
      assert.equal(found.token, undefined, "plaintext token must not be in list response");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/tokens
  // -------------------------------------------------------------------------

  describe("POST /api/tokens", () => {
    it("creates a new setup token with valid name", async () => {
      const res = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "My Device" })
      );
      assert.equal(res.status, 200);
      assert.ok(res.json?.id, "should return token id");
      assert.equal(res.json.name, "My Device");
      assert.ok(typeof res.json.token === "string" && res.json.token.length > 0, "should return plaintext token");
      assert.ok(res.json.createdAt, "should return createdAt");
      assert.ok(res.json.expiresAt, "should return expiresAt");
    });

    it("returns plaintext token only on creation (one-time)", async () => {
      const createRes = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "One-Time Token" })
      );
      assert.equal(createRes.status, 200);
      const { id, token: plaintextToken } = createRes.json;
      assert.ok(typeof plaintextToken === "string", "creation should return token");

      // Listing should not expose the plaintext
      const listRes = await localRequest(TEST_PORT, "GET", "/api/tokens");
      const found = listRes.json.tokens.find(t => t.id === id);
      assert.ok(found, "token should be in list");
      assert.equal(found.token, undefined, "list must not expose plaintext token");
    });

    it("trims whitespace from token name", async () => {
      const res = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "  Padded Name  " })
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.name, "Padded Name");
    });

    it("returns 400 when name is missing", async () => {
      const res = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({})
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error, "should return error message");
    });

    it("returns 400 when name is empty string", async () => {
      const res = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "" })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 when name is whitespace-only", async () => {
      const res = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "   " })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await rawRequest({
        port: TEST_PORT,
        method: "POST",
        path: "/api/tokens",
        headers: { "Content-Type": "application/json", "Host": `localhost:${TEST_PORT}` },
        body: "not valid json",
      });
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/tokens/:id
  // -------------------------------------------------------------------------

  describe("DELETE /api/tokens/:id", () => {
    it("deletes an existing token and returns ok", async () => {
      // Create a token to delete
      const createRes = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "To Be Deleted" })
      );
      assert.equal(createRes.status, 200);
      const { id } = createRes.json;

      const deleteRes = await localRequest(TEST_PORT, "DELETE", `/api/tokens/${id}`);
      assert.equal(deleteRes.status, 200);
      assert.equal(deleteRes.json?.ok, true);

      // Token should no longer appear in list
      const listRes = await localRequest(TEST_PORT, "GET", "/api/tokens");
      const found = listRes.json.tokens.find(t => t.id === id);
      assert.equal(found, undefined, "deleted token should not appear in list");
    });

    it("returns 404 for non-existent token ID", async () => {
      const res = await localRequest(TEST_PORT, "DELETE", "/api/tokens/nonexistent-id-xyz");
      assert.equal(res.status, 404);
      assert.ok(res.json?.error);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/tokens/:id
  // -------------------------------------------------------------------------

  describe("PATCH /api/tokens/:id", () => {
    it("updates token name and returns ok", async () => {
      const createRes = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "Original Name" })
      );
      assert.equal(createRes.status, 200);
      const { id } = createRes.json;

      const patchRes = await localRequest(
        TEST_PORT, "PATCH", `/api/tokens/${id}`,
        JSON.stringify({ name: "Updated Name" })
      );
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.json?.ok, true);

      // Verify name changed in list
      const listRes = await localRequest(TEST_PORT, "GET", "/api/tokens");
      const found = listRes.json.tokens.find(t => t.id === id);
      assert.equal(found?.name, "Updated Name");
    });

    it("returns 404 for non-existent token ID", async () => {
      const res = await localRequest(
        TEST_PORT, "PATCH", "/api/tokens/nonexistent-id-xyz",
        JSON.stringify({ name: "New Name" })
      );
      assert.equal(res.status, 404);
      assert.ok(res.json?.error);
    });

    it("returns 400 when name is missing", async () => {
      const createRes = await localRequest(
        TEST_PORT, "POST", "/api/tokens",
        JSON.stringify({ name: "Patch Test Token" })
      );
      const { id } = createRes.json;

      const res = await localRequest(
        TEST_PORT, "PATCH", `/api/tokens/${id}`,
        JSON.stringify({})
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/credentials
  // -------------------------------------------------------------------------

  describe("GET /api/credentials", () => {
    it("returns empty credentials list when no credentials registered", async () => {
      const res = await localRequest(TEST_PORT, "GET", "/api/credentials");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json?.credentials), "should return credentials array");
      assert.equal(res.json.credentials.length, 0);
    });

    it("returns credential metadata without sensitive fields", async () => {
      // With no registered credentials this is a structural check.
      // Verified fields if credentials exist: id, name, createdAt, lastUsedAt, userAgent, setupTokenId.
      const res = await localRequest(TEST_PORT, "GET", "/api/credentials");
      assert.equal(res.status, 200);
      // All credentials should omit publicKey
      for (const cred of res.json.credentials) {
        assert.equal(cred.publicKey, undefined, "publicKey must not be in response");
      }
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/config/instance-icon
  // -------------------------------------------------------------------------

  describe("PUT /api/config/instance-icon", () => {
    it("sets a valid instance icon and returns success", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/instance-icon",
        JSON.stringify({ instanceIcon: "server" })
      );
      assert.equal(res.status, 200);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.instanceIcon, "server");
    });

    it("accepts icons with hyphens and digits", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/instance-icon",
        JSON.stringify({ instanceIcon: "terminal-window" })
      );
      assert.equal(res.status, 200);
      assert.equal(res.json?.instanceIcon, "terminal-window");
    });

    it("returns 400 for empty string", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/instance-icon",
        JSON.stringify({ instanceIcon: "" })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for icon with invalid characters (uppercase)", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/instance-icon",
        JSON.stringify({ instanceIcon: "MyIcon" })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for icon longer than 50 characters", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/instance-icon",
        JSON.stringify({ instanceIcon: "a".repeat(51) })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for missing instanceIcon field", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/instance-icon",
        JSON.stringify({})
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await rawRequest({
        port: TEST_PORT,
        method: "PUT",
        path: "/api/config/instance-icon",
        headers: { "Content-Type": "application/json", "Host": `localhost:${TEST_PORT}` },
        body: "{bad json",
      });
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/config/toolbar-color
  // -------------------------------------------------------------------------

  describe("PUT /api/config/toolbar-color", () => {
    it("sets a valid toolbar color and returns success", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/toolbar-color",
        JSON.stringify({ toolbarColor: "blue" })
      );
      assert.equal(res.status, 200);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.toolbarColor, "blue");
    });

    it("persists toolbar color across requests", async () => {
      await localRequest(
        TEST_PORT, "PUT", "/api/config/toolbar-color",
        JSON.stringify({ toolbarColor: "red" })
      );

      const getRes = await localRequest(TEST_PORT, "GET", "/api/config");
      assert.equal(getRes.status, 200);
      assert.equal(getRes.json?.config?.toolbarColor, "red");
    });

    it("returns 400 for empty string", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/toolbar-color",
        JSON.stringify({ toolbarColor: "" })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for color longer than 50 characters", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/toolbar-color",
        JSON.stringify({ toolbarColor: "x".repeat(51) })
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for missing toolbarColor field", async () => {
      const res = await localRequest(
        TEST_PORT, "PUT", "/api/config/toolbar-color",
        JSON.stringify({})
      );
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await rawRequest({
        port: TEST_PORT,
        method: "PUT",
        path: "/api/config/toolbar-color",
        headers: { "Content-Type": "application/json", "Host": `localhost:${TEST_PORT}` },
        body: "bad json{",
      });
      assert.equal(res.status, 400);
      assert.ok(res.json?.error);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/config
  // -------------------------------------------------------------------------

  describe("GET /api/config", () => {
    it("returns config object with expected fields", async () => {
      const res = await localRequest(TEST_PORT, "GET", "/api/config");
      assert.equal(res.status, 200);
      assert.ok(res.json?.config, "should return config object");
      assert.ok(typeof res.json.config.instanceName === "string", "config should have instanceName");
      assert.ok(typeof res.json.config.instanceId === "string", "config should have instanceId");
    });
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement tests — server WITHOUT KATULONG_NO_AUTH
// ---------------------------------------------------------------------------

describe("Route Handlers auth enforcement (no KATULONG_NO_AUTH)", () => {
  let authServerProcess;
  let authTestDataDir;

  before(async () => {
    authTestDataDir = mkdtempSync(join(tmpdir(), "katulong-route-handlers-auth-"));

    authServerProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: String(AUTH_TEST_PORT),
        SSH_PORT: String(AUTH_SSH_PORT),
        KATULONG_DATA_DIR: authTestDataDir,
        // No KATULONG_NO_AUTH — real auth enforced
      },
      stdio: "pipe",
    });

    authServerProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[route-handlers auth server] exited with code ${code}\n`);
      }
    });

    await waitForServer(AUTH_TEST_PORT);
  });

  after(() => {
    authServerProcess?.kill();
    if (authTestDataDir) rmSync(authTestDataDir, { recursive: true, force: true });
  });

  // Remote unauthenticated requests should be redirected to /login (302)
  const protectedRoutes = [
    ["GET", "/api/tokens"],
    ["POST", "/api/tokens"],
    ["DELETE", "/api/tokens/some-id"],
    ["GET", "/api/credentials"],
    ["GET", "/api/config"],
    ["PUT", "/api/config/instance-icon"],
    ["PUT", "/api/config/toolbar-color"],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} redirects unauthenticated remote request (302)`, async () => {
      // No body: server rejects before reading body, avoiding ECONNRESET from body write
      const res = await remoteRequest(AUTH_TEST_PORT, method, path);
      assert.equal(
        res.status, 302,
        `expected 302 for unauthenticated remote ${method} ${path}, got ${res.status}: ${res.body}`
      );
      assert.ok(
        res.headers.location?.includes("/login"),
        "should redirect to /login"
      );
    });
  }

  it("localhost request to GET /api/tokens is accepted without auth", async () => {
    const res = await localRequest(AUTH_TEST_PORT, "GET", "/api/tokens");
    assert.equal(res.status, 200, `localhost request should succeed without auth, got ${res.status}`);
    assert.ok(Array.isArray(res.json?.tokens));
  });

  it("localhost request to GET /api/credentials is accepted without auth", async () => {
    const res = await localRequest(AUTH_TEST_PORT, "GET", "/api/credentials");
    assert.equal(res.status, 200, `localhost request should succeed without auth, got ${res.status}`);
    assert.ok(Array.isArray(res.json?.credentials));
  });

  it("localhost request to GET /api/config is accepted without auth", async () => {
    const res = await localRequest(AUTH_TEST_PORT, "GET", "/api/config");
    assert.equal(res.status, 200, `localhost request should succeed without auth, got ${res.status}`);
    assert.ok(res.json?.config);
  });
});
