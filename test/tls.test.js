import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCerts } from "../lib/tls.js";

describe("ensureCerts", () => {
  it("generates CA and server certificates on first call", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      const paths = await ensureCerts(testDir, "test-instance");
      
      assert.ok(existsSync(paths.caCert), "CA cert should exist");
      assert.ok(existsSync(paths.caKey), "CA key should exist");
      assert.ok(existsSync(paths.serverCert), "Server cert should exist");
      assert.ok(existsSync(paths.serverKey), "Server key should exist");
      
      // Check returned paths are correct (in tls/ subdirectory)
      assert.equal(paths.caCert, join(testDir, "tls", "ca.crt"));
      assert.equal(paths.caKey, join(testDir, "tls", "ca.key"));
      assert.equal(paths.serverCert, join(testDir, "tls", "server.crt"));
      assert.equal(paths.serverKey, join(testDir, "tls", "server.key"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("reuses existing certificates on subsequent calls", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      const paths1 = await ensureCerts(testDir, "test-instance");
      const paths2 = await ensureCerts(testDir, "test-instance");
      
      // Should return same paths
      assert.deepEqual(paths1, paths2);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("creates directory if it doesn't exist", async () => {
    const testDir = join(tmpdir(), `katulong-tls-test-${Date.now()}`);
    try {
      assert.ok(!existsSync(testDir), "Test dir should not exist initially");

      await ensureCerts(testDir, "test-instance");
      
      assert.ok(existsSync(testDir), "Test dir should be created");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
