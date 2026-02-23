/**
 * Integration test: Setup token TOCTOU fix (#146)
 *
 * Verifies that /auth/register/verify re-validates the setup token inside
 * withStateLock, closing the race window where a token revoked after
 * /register/options could still be used to complete registration.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { AuthState } from "../lib/auth-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const TEST_PORT = 3006;

function localRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "localhost",
        port: TEST_PORT,
        method,
        path,
        headers: {
          host: `localhost:${TEST_PORT}`,
          ...(bodyStr
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bodyStr),
              }
            : {}),
        },
      },
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("Setup token TOCTOU fix — /register/verify re-validates token under lock (#146)", () => {
  let serverProcess;
  let testDataDir;

  // Plaintext token value used in requests
  const PLAINTEXT_TOKEN = randomBytes(16).toString("hex");
  const TOKEN_ID = "toctou-test-token-id";

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-toctou-"));

    // Build a state with one existing credential (so isSetup() returns true,
    // meaning subsequent registrations require a setup token) and one setup token.
    const stateWithToken = AuthState.empty("owner-user-id", "owner").addCredential({
      id: "existing-cred-id",
      publicKey: Buffer.from("fakepublickey").toString("base64url"),
      counter: 0,
      deviceId: "device-000",
      name: "Owner Device",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent: "test",
      setupTokenId: null,
    }).addSetupToken({
      id: TOKEN_ID,
      token: PLAINTEXT_TOKEN,
      name: "TOCTOU Test Token",
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt: Date.now() + 60 * 60 * 1000, // valid for 1 hour
    });

    writeFileSync(
      join(testDataDir, "katulong-auth.json"),
      JSON.stringify(stateWithToken.toJSON())
    );

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        SSH_PORT: String(TEST_PORT + 10),
        KATULONG_DATA_DIR: testDataDir,
      },
      cwd: ROOT,
      stdio: "pipe",
    });

    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[toctou test server] exited with code ${code}\n`);
      }
    });

    // Wait until the server is ready
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Server did not start in time")),
        10_000
      );
      function poll() {
        http
          .get(
            { host: "localhost", port: TEST_PORT, path: "/auth/status" },
            () => { clearTimeout(deadline); resolve(); }
          )
          .on("error", () => setTimeout(poll, 100));
      }
      poll();
    });
  });

  after(() => {
    serverProcess?.kill();
    if (testDataDir) rmSync(testDataDir, { recursive: true, force: true });
  });

  it("returns 403 when setup token is revoked between /options and /verify", async () => {
    // Step 1: Call /register/options with the valid token — should succeed.
    const optionsRes = await localRequest("POST", "/auth/register/options", {
      setupToken: PLAINTEXT_TOKEN,
    });
    assert.equal(
      optionsRes.status,
      200,
      `/register/options should return 200 with a valid token, got ${optionsRes.status}: ${optionsRes.body}`
    );
    assert.ok(
      optionsRes.json?.challenge,
      "response should include a WebAuthn challenge"
    );

    // Step 2: Revoke the token (simulating an admin action during the WebAuthn ceremony).
    const deleteRes = await localRequest("DELETE", `/api/tokens/${TOKEN_ID}`);
    assert.equal(
      deleteRes.status,
      200,
      `token deletion should succeed, got ${deleteRes.status}: ${deleteRes.body}`
    );

    // Step 3: Call /register/verify with the now-revoked token.
    // The fix ensures the token is re-checked inside withStateLock, so this
    // must be rejected with 403 even though /options accepted the token.
    const verifyRes = await localRequest("POST", "/auth/register/verify", {
      setupToken: PLAINTEXT_TOKEN,
      credential: {
        id: "fake-cred-id",
        rawId: "fake",
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({
              challenge: optionsRes.json.challenge,
              origin: `http://localhost:${TEST_PORT}`,
            })
          ).toString("base64url"),
          attestationObject: "fake",
        },
        type: "public-key",
      },
    });

    assert.equal(
      verifyRes.status,
      403,
      `/register/verify must return 403 when setup token is revoked, got ${verifyRes.status}: ${verifyRes.body}`
    );
  });

  it("does not reject /register/verify when no setup token is provided (first-registration-from-localhost path)", async () => {
    // Call /register/options without a token (localhost first-registration path)
    const optionsRes = await localRequest("POST", "/auth/register/options", {});
    // With an existing credential isFirstRegistration is false, so this will
    // fail at the options stage (no token provided) — status 403.
    // This test ensures the verify endpoint itself does NOT break the no-token path.
    // We call /register/verify without setupToken; the lock should skip the token check.
    const verifyRes = await localRequest("POST", "/auth/register/verify", {
      // No setupToken provided
      credential: {
        id: "fake-cred-id-2",
        rawId: "fake2",
        response: {
          clientDataJSON: Buffer.from(
            JSON.stringify({ challenge: "nonexistent-challenge", origin: `http://localhost:${TEST_PORT}` })
          ).toString("base64url"),
          attestationObject: "fake",
        },
        type: "public-key",
      },
    });

    // Without a setup token the token check inside the lock is skipped.
    // The request should fail at challenge validation (400), not at token
    // validation (403), proving the no-token path is unaffected by the fix.
    assert.notEqual(
      verifyRes.status,
      403,
      `/register/verify without a setup token must not return 403 (that is reserved for token rejection), got ${verifyRes.status}`
    );
  });
});
