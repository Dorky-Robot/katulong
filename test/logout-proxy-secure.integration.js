import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Integration test: Secure cookie flag in logout/revoke-all behind a proxy
 *
 * Regression test for: req.socket.encrypted used instead of isHttpsConnection()
 *
 * When accessing Katulong through a tunnel (ngrok, Cloudflare Tunnel, etc.),
 * req.socket.encrypted is always false because TLS terminates at the proxy.
 * isHttpsConnection() correctly detects the proxy context, so logout must use
 * it instead of req.socket.encrypted to set the Secure cookie flag.
 *
 * We simulate a Cloudflare Tunnel by connecting over loopback and including
 * the CF-Connecting-IP header, which isHttpsConnection() treats as HTTPS.
 */

const TEST_PORT = 3006;
const BASE_URL = `http://localhost:${TEST_PORT}`;

const SESSION_TOKEN_PROXY = "proxy-session-token-abc";
const CSRF_TOKEN_PROXY = "proxy-csrf-token-xyz";
const SESSION_TOKEN_PLAIN = "plain-session-token-def";
const CSRF_TOKEN_PLAIN = "plain-csrf-token-uvw";

function makeAuthState() {
  const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
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
      [SESSION_TOKEN_PROXY]: {
        credentialId: "cred-1",
        expiry,
        createdAt: now,
        lastActivityAt: now,
        csrfToken: CSRF_TOKEN_PROXY,
      },
      [SESSION_TOKEN_PLAIN]: {
        credentialId: "cred-2",
        expiry,
        createdAt: now,
        lastActivityAt: now,
        csrfToken: CSRF_TOKEN_PLAIN,
      },
    },
    setupTokens: [],
  };
}

describe("logout Secure cookie flag", () => {
  let serverProcess;
  let testDataDir;

  before(async () => {
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-logout-proxy-test-"));
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

  it("sets Secure flag on logout cookie when behind Cloudflare Tunnel proxy", async () => {
    // Simulate a Cloudflare Tunnel: connection is loopback + CF-Connecting-IP present.
    // isHttpsConnection() treats this as HTTPS, so the Secure flag should be set.
    // With req.socket.encrypted (the bug), this would NOT be set since TLS terminates at
    // the tunnel edge, not at the Node.js socket.
    const res = await fetch(`${BASE_URL}/auth/logout`, {
      method: "POST",
      headers: {
        "Cookie": `katulong_session=${SESSION_TOKEN_PROXY}`,
        "x-csrf-token": CSRF_TOKEN_PROXY,
        "CF-Connecting-IP": "203.0.113.42",
        "Content-Type": "application/json",
        "Content-Length": "0",
      },
    });

    assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "Expected Set-Cookie header in logout response");
    assert.ok(
      setCookie.includes("; Secure"),
      `Expected '; Secure' flag in Set-Cookie when behind proxy, got: ${setCookie}`
    );
  });

  it("omits Secure flag on logout cookie for plain HTTP (no proxy)", async () => {
    // Plain HTTP connection without proxy headers → isHttpsConnection() returns false.
    const res = await fetch(`${BASE_URL}/auth/logout`, {
      method: "POST",
      headers: {
        "Cookie": `katulong_session=${SESSION_TOKEN_PLAIN}`,
        "x-csrf-token": CSRF_TOKEN_PLAIN,
        "Content-Type": "application/json",
        "Content-Length": "0",
      },
    });

    assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "Expected Set-Cookie header in logout response");
    assert.ok(
      !setCookie.includes("; Secure"),
      `Expected no '; Secure' flag for plain HTTP, got: ${setCookie}`
    );
  });
});
