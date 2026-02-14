import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";

/**
 * Integration tests for Config API endpoints
 *
 * These tests verify that:
 * - GET /api/config returns current configuration
 * - PUT /api/config/instance-name updates instance name
 * - Instance name validation works end-to-end
 * - Changes persist across requests
 */

const TEST_PORT = 3003;
const BASE_URL = `http://localhost:${TEST_PORT}`;

describe("Config API Integration", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    // Create temporary data directory
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-config-api-test-"));

    // Start server with KATULONG_NO_AUTH to bypass authentication
    serverProcess = spawn("node", ["server.js"], {
      env: {
        ...process.env,
        PORT: TEST_PORT,
        HTTPS_PORT: TEST_PORT + 1, // Use 3004 for HTTPS
        SSH_PORT: TEST_PORT + 10, // Use 3013 for SSH
        KATULONG_DATA_DIR: testDataDir, // Use correct env var name
        KATULONG_NO_AUTH: "1" // Bypass auth for testing
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
          const response = await fetch(`${BASE_URL}/api/config`);
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

  describe("GET /api/config", () => {
    it("should return current configuration", async () => {
      const response = await fetch(`${BASE_URL}/api/config`);
      assert.strictEqual(response.status, 200, "Should return 200 OK");

      const data = await response.json();
      assert.ok(data.config, "Response should have config object");
      assert.ok(data.config.instanceName, "Config should have instance name");
      assert.strictEqual(
        data.config.instanceName,
        hostname(),
        "Default instance name should be hostname"
      );
      assert.ok(data.config.createdAt, "Config should have createdAt");
      assert.ok(data.config.updatedAt, "Config should have updatedAt");
    });
  });

  describe("PUT /api/config/instance-name", () => {
    it("should update instance name", async () => {
      const newName = "Test Instance";

      const response = await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: newName })
      });

      assert.strictEqual(response.status, 200, "Should return 200 OK");

      const data = await response.json();
      assert.strictEqual(data.success, true, "Should indicate success");
      assert.strictEqual(data.instanceName, newName, "Should return updated name");

      // Verify persistence by fetching again
      const getResponse = await fetch(`${BASE_URL}/api/config`);
      const getData = await getResponse.json();
      assert.strictEqual(
        getData.config.instanceName,
        newName,
        "Updated name should persist"
      );
    });

    it("should trim whitespace", async () => {
      const response = await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: "  Trimmed Name  " })
      });

      const data = await response.json();
      assert.strictEqual(data.instanceName, "Trimmed Name", "Should trim whitespace");
    });

    it("should reject empty string", async () => {
      const response = await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: "" })
      });

      assert.strictEqual(response.status, 400, "Should return 400 Bad Request");

      const data = await response.json();
      assert.ok(data.error, "Should return error message");
      assert.match(data.error, /non-empty string/, "Error should mention non-empty requirement");
    });

    it("should reject whitespace-only string", async () => {
      const response = await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: "   " })
      });

      assert.strictEqual(response.status, 400, "Should return 400 Bad Request");
    });

    it("should reject names longer than 100 characters", async () => {
      const longName = "a".repeat(101);
      const response = await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: longName })
      });

      assert.strictEqual(response.status, 400, "Should return 400 Bad Request");

      const data = await response.json();
      assert.match(data.error, /100 characters or less/, "Error should mention length limit");
    });

    it("should accept names exactly 100 characters", async () => {
      const name100 = "a".repeat(100);
      const response = await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: name100 })
      });

      assert.strictEqual(response.status, 200, "Should accept 100 character name");

      const data = await response.json();
      assert.strictEqual(data.instanceName, name100, "Should save 100 character name");
    });

    it("should update updatedAt timestamp", async () => {
      // Get initial timestamp
      const getResponse1 = await fetch(`${BASE_URL}/api/config`);
      const getData1 = await getResponse1.json();
      const originalUpdatedAt = getData1.config.updatedAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Update instance name
      await fetch(`${BASE_URL}/api/config/instance-name`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ instanceName: "Updated Name" })
      });

      // Get updated timestamp
      const getResponse2 = await fetch(`${BASE_URL}/api/config`);
      const getData2 = await getResponse2.json();
      const newUpdatedAt = getData2.config.updatedAt;

      assert.notStrictEqual(
        newUpdatedAt,
        originalUpdatedAt,
        "updatedAt should change after update"
      );
    });
  });
});
