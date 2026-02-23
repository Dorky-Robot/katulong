import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration test: credential-removed broadcast path in logout handler
 *
 * Regression test for: broadcast() ReferenceError in /auth/logout
 *
 * The logout handler calls broadcastToAll() when a credential is removed
 * (newState.removedCredentialId is set). A previous bug used broadcast()
 * which does not exist in server.js, causing a ReferenceError and 500 response.
 *
 * This test exercises that exact path to prevent regression.
 */

const TEST_PORT = 3004;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Pre-seeded auth state: two credentials so removing one doesn't hit last-credential lock
const SESSION_TOKEN = "test-session-token-abc123";
const CSRF_TOKEN = "test-csrf-token-xyz789";
const CREDENTIAL_ID = "cred-1";

function makeAuthState() {
  const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();
  return {
    user: { id: "test-user-id", name: "Test User" },
    credentials: [
      {
        id: "cred-1",
        publicKey: Buffer.from("test-key-1").toString("base64url"),
        counter: 0,
        deviceId: "device-1",
        name: "Device 1",
        createdAt: now,
        lastUsedAt: now,
        userAgent: "Test/1.0",
      },
      {
        id: "cred-2",
        publicKey: Buffer.from("test-key-2").toString("base64url"),
        counter: 0,
        deviceId: "device-2",
        name: "Device 2",
        createdAt: now,
        lastUsedAt: now,
        userAgent: "Test/1.0",
      },
    ],
    sessions: {
      [SESSION_TOKEN]: {
        credentialId: CREDENTIAL_ID,
        expiry,
        createdAt: now,
        lastActivityAt: now,
        csrfToken: CSRF_TOKEN,
      },
    },
    setupTokens: [],
  };
}

describe("logout broadcast path", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-logout-broadcast-test-"));

    // Write pre-seeded auth state so endSession() will set removedCredentialId
    writeFileSync(
      join(testDataDir, "katulong-auth.json"),
      JSON.stringify(makeAuthState()),
      "utf-8"
    );

    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: TEST_PORT,
        SSH_PORT: TEST_PORT + 10,
        KATULONG_DATA_DIR: testDataDir,
      },
      stdio: "pipe",
    });

    let serverOutput = "";
    serverProcess.stderr.on("data", (d) => { serverOutput += d.toString(); });
    serverProcess.stdout.on("data", (d) => { serverOutput += d.toString(); });

    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Test server exited with code ${code}\n${serverOutput}`);
      }
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Server failed to start within 10s.\n${serverOutput}`));
      }, 10000);

      const startTime = Date.now();
      const checkReady = async () => {
        try {
          // Any 2xx or 4xx means server is up (401 is expected without auth)
          const res = await fetch(`${BASE_URL}/`);
          if (res.status < 500) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // Not ready yet
        }
        if (Date.now() - startTime < 10000) {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  });

  after(() => {
    serverProcess?.kill();
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 200 (not 500) when logout removes a credential", async () => {
    // This request exercises the path:
    //   endSession() → removedCredentialId set → broadcastToAll() called
    //
    // If broadcast() (the old bug) were used, this would throw ReferenceError → 500.
    // broadcastToAll() is correct and should succeed → 200.
    const res = await fetch(`${BASE_URL}/auth/logout`, {
      method: "POST",
      headers: {
        "Cookie": `katulong_session=${SESSION_TOKEN}`,
        "x-csrf-token": CSRF_TOKEN,
        "Host": `localhost:${TEST_PORT}`,
        "Content-Type": "application/json",
        "Content-Length": "0",
      },
    });

    assert.strictEqual(
      res.status,
      200,
      `Expected 200 but got ${res.status} — a 500 here likely means broadcast() ReferenceError`
    );

    const body = await res.json();
    assert.strictEqual(body.ok, true);
  });
});
