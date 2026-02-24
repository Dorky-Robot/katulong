import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAuthFixture } from "./helpers/auth-fixture.js";

/**
 * Integration tests for DELETE /api/credentials/:id endpoint
 *
 * These tests verify that:
 * - GET /api/credentials returns all registered credentials
 * - DELETE /api/credentials/:id removes a specific credential
 * - After deletion, the credential no longer appears in GET
 * - DELETE for a nonexistent credential returns 404
 */

const TEST_PORT = 3009;
const BASE_URL = `http://localhost:${TEST_PORT}`;

const AUTH_STATE = {
  user: { id: "dGVzdA", name: "test" },
  credentials: [
    {
      id: "TiFXfP8_p3Uh3FbBj6KbGA",
      publicKey: "dGVzdA",
      counter: 0,
      name: "Test Device 1",
      deviceId: null,
      createdAt: 1700000000000,
      lastUsedAt: 1700000000000,
      userAgent: "test"
    },
    {
      id: "ABCDeFgHiJkLmNoPqRsTuV",
      publicKey: "dGVzdA",
      counter: 0,
      name: "Test Device 2",
      deviceId: null,
      createdAt: 1700000000000,
      lastUsedAt: 1700000000000,
      userAgent: "test"
    }
  ],
  sessions: {},
  setupTokens: []
};

describe("Credential Revoke Integration", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    // Create temporary data directory
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-credential-revoke-test-"));

    // Write auth state with known credentials as per-entity files
    writeAuthFixture(testDataDir, AUTH_STATE);

    // Start server with KATULONG_NO_AUTH to bypass authentication
    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: TEST_PORT,
        SSH_PORT: TEST_PORT + 10, // Use 3019 for SSH
        KATULONG_DATA_DIR: testDataDir,
        KATULONG_NO_AUTH: "1"
      },
      stdio: "pipe"
    });

    // Capture stdout/stderr for debugging
    let serverOutput = "";
    serverProcess.stderr.on("data", (data) => {
      serverOutput += data.toString();
    });
    serverProcess.stdout.on("data", (data) => {
      serverOutput += data.toString();
    });

    // Handle unexpected exit
    serverProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Server process exited with code ${code}`);
      }
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const errorMsg = `Server failed to start within 10 seconds.\nServer output:\n${serverOutput}`;
        reject(new Error(errorMsg));
      }, 10000);

      const startTime = Date.now();
      const checkReady = async () => {
        try {
          const response = await fetch(`${BASE_URL}/api/credentials`);
          if (response.ok) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        } catch (error) {
          // Server not ready yet, retry
          if (Date.now() - startTime < 10000) {
            setTimeout(checkReady, 100);
          }
        }
      };

      checkReady();
    });
  });

  after(() => {
    // Clean up
    if (serverProcess) {
      serverProcess.kill();
    }
    if (testDataDir) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("GET /api/credentials", () => {
    it("should return both credentials with correct IDs", async () => {
      const response = await fetch(`${BASE_URL}/api/credentials`);
      assert.strictEqual(response.status, 200, "Should return 200 OK");

      const data = await response.json();
      assert.ok(data.credentials, "Response should have credentials array");
      assert.strictEqual(data.credentials.length, 2, "Should have 2 credentials");

      const ids = data.credentials.map(c => c.id);
      assert.ok(ids.includes("TiFXfP8_p3Uh3FbBj6KbGA"), "Should contain first credential ID");
      assert.ok(ids.includes("ABCDeFgHiJkLmNoPqRsTuV"), "Should contain second credential ID");
    });
  });

  describe("DELETE /api/credentials/:id", () => {
    it("should delete an existing credential and return 200", async () => {
      const response = await fetch(
        `${BASE_URL}/api/credentials/TiFXfP8_p3Uh3FbBj6KbGA`,
        { method: "DELETE" }
      );
      assert.strictEqual(response.status, 200, "Should return 200 OK");

      const data = await response.json();
      assert.strictEqual(data.ok, true, "Should indicate success");
    });

    it("should no longer return the deleted credential in GET", async () => {
      const response = await fetch(`${BASE_URL}/api/credentials`);
      assert.strictEqual(response.status, 200, "Should return 200 OK");

      const data = await response.json();
      assert.strictEqual(data.credentials.length, 1, "Should have 1 credential remaining");
      assert.strictEqual(
        data.credentials[0].id,
        "ABCDeFgHiJkLmNoPqRsTuV",
        "Remaining credential should be the one that was not deleted"
      );
    });

    it("should return 404 for a nonexistent credential", async () => {
      const response = await fetch(
        `${BASE_URL}/api/credentials/nonexistent`,
        { method: "DELETE" }
      );
      assert.strictEqual(response.status, 404, "Should return 404 Not Found");

      const data = await response.json();
      assert.ok(data.error, "Should return an error message");
    });
  });
});
