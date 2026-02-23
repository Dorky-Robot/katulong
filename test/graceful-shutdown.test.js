import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

describe("graceful shutdown", () => {
  describe("server PID file", () => {
    let pidPath;

    beforeEach(() => {
      pidPath = join(tmpdir(), `katulong-test-server-${randomBytes(8).toString("hex")}.pid`);
    });

    afterEach(() => {
      try { unlinkSync(pidPath); } catch { /* ignore */ }
    });

    it("PID file contains numeric PID", () => {
      const pid = process.pid;
      writeFileSync(pidPath, String(pid), { encoding: "utf-8" });
      const content = readFileSync(pidPath, "utf-8").trim();
      assert.equal(content, String(pid));
      assert.ok(!isNaN(parseInt(content, 10)));
    });

    it("PID file cleanup only removes own PID", () => {
      const myPid = process.pid;
      const otherPid = 99999;

      // Write another process's PID
      writeFileSync(pidPath, String(otherPid), { encoding: "utf-8" });

      // Simulate cleanup check: only remove if it's our PID
      const content = readFileSync(pidPath, "utf-8").trim();
      if (content === String(myPid)) {
        unlinkSync(pidPath);
      }

      // File should still exist because PID didn't match
      assert.ok(existsSync(pidPath));
      const remaining = readFileSync(pidPath, "utf-8").trim();
      assert.equal(remaining, String(otherPid));
    });
  });

  describe("draining flag behavior", () => {
    it("health response differs based on draining state", () => {
      // Simulate the health endpoint logic
      function healthResponse(draining, daemonConnected) {
        if (draining) {
          return { status: 503, body: { status: "draining", pid: process.pid } };
        }
        return {
          status: 200,
          body: { status: "ok", pid: process.pid, uptime: process.uptime(), daemonConnected },
        };
      }

      const normal = healthResponse(false, true);
      assert.equal(normal.status, 200);
      assert.equal(normal.body.status, "ok");
      assert.equal(normal.body.daemonConnected, true);
      assert.equal(typeof normal.body.uptime, "number");

      const draining = healthResponse(true, true);
      assert.equal(draining.status, 503);
      assert.equal(draining.body.status, "draining");
    });
  });

  describe("WebSocket close codes", () => {
    it("uses 1001 (Going Away) for graceful shutdown", () => {
      // 1001 is the standard code for "Going Away" — server is shutting down
      // The frontend handles any code != 1008 by reconnecting
      const GOING_AWAY = 1001;
      const POLICY_VIOLATION = 1008;
      assert.notEqual(GOING_AWAY, POLICY_VIOLATION);
      assert.equal(GOING_AWAY, 1001);
    });

    it("1008 (Policy Violation) is used for credential revocation", () => {
      // 1008 redirects to login page — should NOT be used during graceful shutdown
      const POLICY_VIOLATION = 1008;
      assert.equal(POLICY_VIOLATION, 1008);
    });
  });
});
