/**
 * Integration tests for WebSocket upgrade authentication and origin validation.
 *
 * Covers the handleUpgrade() function in server.js which enforces:
 * 1. Session cookie validation — unauthenticated upgrades are rejected with 401
 * 2. Origin header validation — non-localhost upgrades without matching Origin get 403
 * 3. Localhost bypass — loopback socket + local Host/Origin headers bypass auth
 *
 * Uses raw HTTP upgrade requests via Node.js http module to control headers precisely.
 * Simulates non-localhost access by connecting from loopback with a non-local Host header
 * (the same technique isLocalRequest() uses: it checks Host + socket address, not just
 * socket address, so tunnelled traffic via ngrok/Cloudflare is not treated as local).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

const TEST_PORT = 3008;

// Non-local Host header used to simulate tunnel (ngrok/Cloudflare) traffic.
// isLocalRequest() sees loopback socket + non-local Host → returns false → auth enforced.
const REMOTE_HOST = "example.ngrok.app";

// Fixed session tokens embedded in the pre-seeded auth state file.
const VALID_TOKEN = "ws-valid-session-token-abc123def456789";
const EXPIRED_TOKEN = "ws-expired-session-token-xyz789abc123";
const CREDENTIAL_ID = "ws-test-credential-id-1";

/**
 * Build an AuthState-compatible JSON with one valid and one expired session.
 * Written to the temp data dir before the server starts so loadState() picks it up.
 */
function makeAuthState() {
  const now = Date.now();
  return {
    user: { id: "ws-test-user", name: "WS Test User" },
    credentials: [
      {
        id: CREDENTIAL_ID,
        publicKey: Buffer.from("ws-test-key").toString("base64url"),
        counter: 0,
        deviceId: "ws-device-1",
        name: "WS Test Device",
        createdAt: now,
        lastUsedAt: now,
        userAgent: "Test/1.0",
      },
    ],
    sessions: {
      [VALID_TOKEN]: {
        credentialId: CREDENTIAL_ID,
        expiry: now + 30 * 24 * 60 * 60 * 1000, // 30 days from now
        createdAt: now,
        lastActivityAt: now,
        csrfToken: "ws-csrf-token-1",
      },
      [EXPIRED_TOKEN]: {
        credentialId: CREDENTIAL_ID,
        expiry: now - 1000, // 1 second in the past
        createdAt: now - 3600000,
        lastActivityAt: now - 3600000,
        csrfToken: "ws-csrf-token-2",
      },
    },
    setupTokens: [],
  };
}

/**
 * Send a raw HTTP WebSocket upgrade request and return the response status code.
 *
 * Returns:
 * - 101 if the server accepted the upgrade (WebSocket handshake completed)
 * - 401 if authentication failed
 * - 403 if origin validation failed
 *
 * @param {object} headers - Headers merged over the default upgrade headers
 */
function wsUpgrade(headers = {}) {
  return new Promise((resolve, reject) => {
    // RFC 6455 §4.1 example Sec-WebSocket-Key: base64(16-byte nonce)
    const key = "dGhlIHNhbXBsZSBub25jZQ==";

    const req = http.request({
      host: "localhost",
      port: TEST_PORT,
      method: "GET",
      path: "/",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });

    // Server accepted the WebSocket upgrade — destroy socket cleanly
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });

    // Server rejected with a regular HTTP response (401, 403, etc.)
    req.on("response", (res) => {
      res.resume(); // drain body to free resources
      resolve(res.statusCode);
    });

    req.on("error", reject);
    req.end();
  });
}

describe("WebSocket upgrade authentication and origin validation", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-ws-upgrade-test-"));

    // Write pre-seeded auth state so the server has known valid/expired sessions
    writeFileSync(
      join(testDataDir, "katulong-auth.json"),
      JSON.stringify(makeAuthState()),
      "utf-8"
    );

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SSH_PORT: String(TEST_PORT + 10),
        KATULONG_DATA_DIR: testDataDir,
      },
      stdio: "pipe",
    });

    let serverOutput = "";
    serverProcess.stdout.on("data", (d) => { serverOutput += d.toString(); });
    serverProcess.stderr.on("data", (d) => { serverOutput += d.toString(); });

    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Test server exited with code ${code}\n${serverOutput}`);
      }
    });

    // Poll until server is ready (any non-5xx response)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Server failed to start within 10s.\n${serverOutput}`));
      }, 10000);

      const checkReady = async () => {
        try {
          const res = await fetch(`http://localhost:${TEST_PORT}/`);
          if (res.status < 500) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // Server not ready yet — retry
        }
        setTimeout(checkReady, 100);
      };

      checkReady();
    });
  });

  after(() => {
    serverProcess?.kill();
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // Authentication tests
  // ---------------------------------------------------------------------------
  describe("authentication", () => {
    it("rejects upgrade with no session cookie → 401", async () => {
      // Non-local Host forces isLocalRequest() to return false → auth enforced
      // No cookie → isAuthenticated() returns false → 401
      const status = await wsUpgrade({ Host: REMOTE_HOST });
      assert.strictEqual(status, 401);
    });

    it("rejects upgrade with expired session cookie → 401", async () => {
      // Session exists in auth state but expiry is in the past → 401
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: `katulong_session=${EXPIRED_TOKEN}`,
      });
      assert.strictEqual(status, 401);
    });

    it("accepts upgrade with valid session cookie and matching Origin → 101", async () => {
      // Valid session + Origin matching Host → auth and origin checks both pass
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: `katulong_session=${VALID_TOKEN}`,
        Origin: `http://${REMOTE_HOST}`,
      });
      assert.strictEqual(status, 101);
    });

    it("accepts upgrade from localhost without session cookie → 101", async () => {
      // Loopback socket + localhost Host + absent Origin → isLocalRequest() = true
      // isAuthenticated() returns true via localhost bypass → upgrade proceeds
      const status = await wsUpgrade({
        Host: `localhost:${TEST_PORT}`,
        // No Cookie — auth is bypassed for localhost
      });
      assert.strictEqual(status, 101);
    });
  });

  // ---------------------------------------------------------------------------
  // Origin validation tests
  // All non-localhost tests include a valid session to isolate the origin check.
  // ---------------------------------------------------------------------------
  describe("origin validation", () => {
    it("rejects upgrade with missing Origin header (non-localhost) → 403", async () => {
      // Auth passes (valid session), but Origin is absent → 403
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: `katulong_session=${VALID_TOKEN}`,
        // No Origin header
      });
      assert.strictEqual(status, 403);
    });

    it("rejects upgrade with Origin that does not match Host → 403", async () => {
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: `katulong_session=${VALID_TOKEN}`,
        Origin: "http://attacker.example.com",
      });
      assert.strictEqual(status, 403);
    });

    it("accepts upgrade with Origin matching Host → 101", async () => {
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: `katulong_session=${VALID_TOKEN}`,
        Origin: `http://${REMOTE_HOST}`,
      });
      assert.strictEqual(status, 101);
    });

    it("accepts upgrade from localhost with local Origin on different port → 101", async () => {
      // isLocalRequest() checks that Origin includes "://localhost" (not exact port match)
      // So localhost:9999 origin with localhost:PORT host is treated as a local request.
      // handleUpgrade then skips the strict Origin===Host check for local requests.
      const status = await wsUpgrade({
        Host: `localhost:${TEST_PORT}`,
        Origin: "http://localhost:9999",
      });
      assert.strictEqual(status, 101);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe("edge cases", () => {
    it("rejects upgrade when Origin header is empty string → 403", async () => {
      // Empty string is falsy: !'' === true, treated same as absent Origin → 403
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: `katulong_session=${VALID_TOKEN}`,
        Origin: "",
      });
      assert.strictEqual(status, 403);
    });

    it("rejects upgrade with malformed cookie that contains no session token → 401", async () => {
      // parseCookies() finds no katulong_session key → auth fails → 401
      const status = await wsUpgrade({
        Host: REMOTE_HOST,
        Cookie: "invalid;;;garbage=value",
      });
      assert.strictEqual(status, 401);
    });
  });
});
