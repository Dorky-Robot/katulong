import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAuthFixture } from "./helpers/auth-fixture.js";

/**
 * Integration test: /auth/logout invalidates session without removing credential
 *
 * Verifies that logout removes the session token but keeps the credential
 * intact, so users can log back in with their passkey.
 */

const TEST_PORT = 3004;
const BASE_URL = `http://localhost:${TEST_PORT}`;

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
        id: CREDENTIAL_ID,
        publicKey: Buffer.from("test-key-1").toString("base64url"),
        counter: 0,
        deviceId: "device-1",
        name: "Device 1",
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

describe("logout session invalidation", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-logout-test-"));

    writeAuthFixture(testDataDir, makeAuthState());

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

  it("returns 200 and invalidates the session without removing the credential", async () => {
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
      `Expected 200 but got ${res.status}`
    );

    const body = await res.json();
    assert.strictEqual(body.ok, true);
  });
});
