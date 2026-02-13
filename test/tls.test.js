import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCerts, inspectCert, needsRegeneration, regenerateServerCert } from "../lib/tls.js";

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

  it("regenerates certificates when force option is true", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      // Generate initial certificates
      const paths1 = await ensureCerts(testDir, "test-instance");
      const caCert1 = readFileSync(paths1.caCert, "utf-8");
      const serverCert1 = readFileSync(paths1.serverCert, "utf-8");

      // Wait a bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Force regeneration
      const paths2 = await ensureCerts(testDir, "test-instance", { force: true });
      const caCert2 = readFileSync(paths2.caCert, "utf-8");
      const serverCert2 = readFileSync(paths2.serverCert, "utf-8");

      // Certificates should be different
      assert.notEqual(caCert1, caCert2, "CA cert should be regenerated");
      assert.notEqual(serverCert1, serverCert2, "Server cert should be regenerated");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("inspectCert", () => {
  it("returns exists: false when certificate doesn't exist", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      const result = inspectCert(testDir);
      assert.equal(result.exists, false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns certificate details when certificate exists", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      await ensureCerts(testDir, "test-instance");

      const result = inspectCert(testDir);
      assert.equal(result.exists, true);
      assert.ok(result.notBefore instanceof Date);
      assert.ok(result.notAfter instanceof Date);
      assert.ok(Array.isArray(result.sans.ips));
      assert.ok(Array.isArray(result.sans.dns));

      // Should include localhost
      assert.ok(result.sans.dns.includes("localhost"));
      // Should include loopback IPs
      assert.ok(result.sans.ips.includes("127.0.0.1"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("needsRegeneration", () => {
  it("returns needed: true when certificate doesn't exist", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      const result = needsRegeneration(testDir);
      assert.equal(result.needed, true);
      assert.ok(result.reason.includes("does not exist"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns needed: false when certificate includes all current IPs", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      await ensureCerts(testDir, "test-instance");

      const result = needsRegeneration(testDir);
      assert.equal(result.needed, false);
      assert.ok(result.reason.includes("up to date"));
      assert.equal(result.missingIps.length, 0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("regenerateServerCert", () => {
  it("throws error when CA doesn't exist", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      assert.throws(
        () => regenerateServerCert(testDir, "test-instance"),
        /CA certificate not found/
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("regenerates server certificate while preserving CA", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      // Generate initial certificates
      const paths = await ensureCerts(testDir, "test-instance");
      const caCert1 = readFileSync(paths.caCert, "utf-8");
      const serverCert1 = readFileSync(paths.serverCert, "utf-8");

      // Wait a bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Regenerate server cert only
      regenerateServerCert(testDir, "test-instance");

      const caCert2 = readFileSync(paths.caCert, "utf-8");
      const serverCert2 = readFileSync(paths.serverCert, "utf-8");

      // CA should be unchanged
      assert.equal(caCert1, caCert2, "CA cert should be preserved");
      // Server cert should be different
      assert.notEqual(serverCert1, serverCert2, "Server cert should be regenerated");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("includes current IPs in regenerated certificate", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      // Generate initial certificates
      await ensureCerts(testDir, "test-instance");

      // Regenerate server cert
      regenerateServerCert(testDir, "test-instance");

      // Inspect new certificate
      const certInfo = inspectCert(testDir);

      // Should still include localhost and loopback
      assert.ok(certInfo.sans.dns.includes("localhost"));
      assert.ok(certInfo.sans.ips.includes("127.0.0.1"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
