import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCerts, inspectCert, needsRegeneration, regenerateServerCert } from "../lib/tls.js";
import forge from "node-forge";

describe("ensureCerts", () => {
  it("generates CA and server certificates on first call", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      const paths = await ensureCerts(testDir, "test-instance", "test-uuid-1234");
      
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
      const paths1 = await ensureCerts(testDir, "test-instance", "test-uuid-1234");
      const paths2 = await ensureCerts(testDir, "test-instance", "test-uuid-1234");
      
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

      await ensureCerts(testDir, "test-instance", "test-uuid-1234");

      assert.ok(existsSync(testDir), "Test dir should be created");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("regenerates certificates when force option is true", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      // Generate initial certificates
      const paths1 = await ensureCerts(testDir, "test-instance", "test-uuid-1234");
      const caCert1 = readFileSync(paths1.caCert, "utf-8");
      const caKey1 = readFileSync(paths1.caKey, "utf-8");
      const serverCert1 = readFileSync(paths1.serverCert, "utf-8");

      // Wait a bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Force regeneration with same instance ID
      const paths2 = await ensureCerts(testDir, "test-instance", "test-uuid-1234", { force: true });
      const caCert2 = readFileSync(paths2.caCert, "utf-8");
      const caKey2 = readFileSync(paths2.caKey, "utf-8");
      const serverCert2 = readFileSync(paths2.serverCert, "utf-8");

      // Certificates and keys should be different (different keys generated)
      assert.notEqual(caCert1, caCert2, "CA cert should be regenerated");
      assert.notEqual(caKey1, caKey2, "CA key should be regenerated");
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
      await ensureCerts(testDir, "test-instance", "test-uuid-1234");

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
      await ensureCerts(testDir, "test-instance", "test-uuid-1234");

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
      const paths = await ensureCerts(testDir, "test-instance", "test-uuid-1234");
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
      await ensureCerts(testDir, "test-instance", "test-uuid-1234");

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

  it("includes instance ID in CA certificate", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      const instanceId = "12345678-1234-1234-1234-123456789012";
      await ensureCerts(testDir, "test-instance", instanceId);

      // Read and parse the CA certificate
      const caCertPath = join(testDir, "tls", "ca.crt");
      const caCertPem = readFileSync(caCertPath, "utf-8");
      const caCert = forge.pki.certificateFromPem(caCertPem);

      // Get the common name (which now includes instance ID)
      const cnField = caCert.subject.getField("CN");
      const commonName = cnField.value;

      // The common name should contain "Katulong" and the first 8 chars of the instance ID
      const shortId = instanceId.substring(0, 8);
      assert.ok(commonName.includes("Katulong"), `Common name "${commonName}" should contain "Katulong"`);
      assert.ok(commonName.includes(shortId), `Common name "${commonName}" should contain instance ID prefix ${shortId}`);
      assert.strictEqual(commonName, `Katulong - test-instance (${shortId})`, "Common name should match expected format");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("generates unique CA certs for different instance IDs", async () => {
    const testDir1 = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    const testDir2 = mkdtempSync(join(tmpdir(), "katulong-tls-test-"));
    try {
      // Generate certs for two instances with same name but different IDs
      await ensureCerts(testDir1, "test-instance", "11111111-1111-1111-1111-111111111111");
      await ensureCerts(testDir2, "test-instance", "22222222-2222-2222-2222-222222222222");

      // Parse the CA certificates
      const caCertPem1 = readFileSync(join(testDir1, "tls", "ca.crt"), "utf-8");
      const caCertPem2 = readFileSync(join(testDir2, "tls", "ca.crt"), "utf-8");
      const caCert1 = forge.pki.certificateFromPem(caCertPem1);
      const caCert2 = forge.pki.certificateFromPem(caCertPem2);

      // Certificates should be different
      assert.notEqual(caCertPem1, caCertPem2, "CA certs with different instance IDs should be different");

      // Get common names (which now includes instance ID)
      const commonName1 = caCert1.subject.getField("CN").value;
      const commonName2 = caCert2.subject.getField("CN").value;

      // First should contain its ID prefix
      assert.ok(commonName1.includes("11111111"), `First common name "${commonName1}" should contain its instance ID prefix`);
      assert.ok(!commonName1.includes("22222222"), `First common name "${commonName1}" should not contain second instance ID prefix`);

      // Second should contain its ID prefix
      assert.ok(commonName2.includes("22222222"), `Second common name "${commonName2}" should contain its instance ID prefix`);
      assert.ok(!commonName2.includes("11111111"), `Second common name "${commonName2}" should not contain first instance ID prefix`);

      // Verify expected format with "Katulong" prefix
      assert.strictEqual(commonName1, "Katulong - test-instance (11111111)", "First common name should match expected format");
      assert.strictEqual(commonName2, "Katulong - test-instance (22222222)", "Second common name should match expected format");
    } finally {
      rmSync(testDir1, { recursive: true, force: true });
      rmSync(testDir2, { recursive: true, force: true });
    }
  });
});
