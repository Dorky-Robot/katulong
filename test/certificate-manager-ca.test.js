import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CertificateManager } from "../lib/certificate-manager.js";
import { ConfigManager } from "../lib/config.js";
import { ensureCerts } from "../lib/tls.js";
import forge from "node-forge";

/**
 * Tests for CA certificate regeneration with dynamic instance names
 */

describe("CertificateManager - CA Regeneration", () => {
  let testDataDir;
  let configManager;
  let certManager;

  beforeEach(() => {
    // Create temp directory for each test
    testDataDir = mkdtempSync(join(tmpdir(), "katulong-ca-test-"));

    // Initialize config manager
    configManager = new ConfigManager(testDataDir);
    configManager.initialize();

    // Ensure initial CA exists
    const instanceName = configManager.getInstanceName();
    const instanceId = configManager.getInstanceId();
    ensureCerts(testDataDir, instanceName, instanceId);

    // Initialize certificate manager
    certManager = new CertificateManager(testDataDir, configManager);
  });

  after(() => {
    if (testDataDir) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("should use current instance name when regenerating CA", async () => {
    // Get initial CA common name
    const initialCaCert = readCACommonName(testDataDir);
    const initialInstanceName = configManager.getInstanceName();
    const initialInstanceId = configManager.getInstanceId();
    const initialShortId = initialInstanceId.substring(0, 8);
    assert.strictEqual(initialCaCert, `Katulong - ${initialInstanceName} (${initialShortId})`);

    // Change instance name
    configManager.setInstanceName("New Instance");

    // Regenerate CA
    await certManager.regenerateCA();

    // Verify CA has new instance name (with same instance ID)
    const newCaCert = readCACommonName(testDataDir);
    const newInstanceId = configManager.getInstanceId();
    const newShortId = newInstanceId.substring(0, 8);
    assert.strictEqual(newCaCert, `Katulong - New Instance (${newShortId})`);
  });

  it("should backup old CA before regenerating", async () => {
    // Regenerate CA
    await certManager.regenerateCA();

    // Check backup exists
    const backupDir = join(testDataDir, "tls", "backups");
    assert.ok(existsSync(backupDir), "Backup directory should exist");

    const { readdirSync } = await import("fs");
    const backupFiles = readdirSync(backupDir);
    const caBackups = backupFiles.filter(f => f.startsWith("ca.crt."));
    assert.ok(caBackups.length > 0, "Should have at least one CA backup");
  });

  it("should be able to restore backed up CA", async () => {
    const initialCaContent = readFileSync(join(testDataDir, "tls", "ca.crt"), "utf-8");

    // Regenerate CA (creates backup)
    const backupId = await certManager.regenerateCA();

    // Change instance name and regenerate again
    configManager.setInstanceName("Another Instance");
    await certManager.regenerateCA();

    // Restore the first backup
    await certManager.restoreCABackup(backupId);

    // Verify CA is restored
    const restoredCaContent = readFileSync(join(testDataDir, "tls", "ca.crt"), "utf-8");
    assert.strictEqual(restoredCaContent, initialCaContent);
  });

  it("should list available CA backups", async () => {
    // Create multiple backups
    await certManager.regenerateCA();
    configManager.setInstanceName("Second Instance");
    await certManager.regenerateCA();
    configManager.setInstanceName("Third Instance");
    await certManager.regenerateCA();

    // List backups
    const backups = await certManager.listCABackups();
    assert.ok(backups.length >= 3, "Should have at least 3 backups");

    // Verify backup structure
    const firstBackup = backups[0];
    assert.ok(firstBackup.id, "Backup should have ID");
    assert.ok(firstBackup.timestamp, "Backup should have timestamp");
    assert.ok(firstBackup.instanceName, "Backup should have instance name");
  });

  it("should clean up old backups (keep last 5)", async () => {
    // Create 10 backups
    for (let i = 0; i < 10; i++) {
      configManager.setInstanceName(`Instance ${i}`);
      await certManager.regenerateCA();
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // List backups
    const backups = await certManager.listCABackups();
    assert.ok(backups.length <= 5, "Should keep at most 5 backups");
  });
});

describe("CertificateManager - CA/Network Cert Chain Integrity", () => {
  it("regenerateCA followed by initialize re-signs orphaned network certs", async () => {
    // Simulates: user upgrades katulong, CA gets regenerated (new format),
    // but network certs are still signed by old CA. On next startup,
    // validateNetworkCerts() should detect and fix the mismatch.
    const testDir = mkdtempSync(join(tmpdir(), "katulong-ca-chain-test-"));
    try {
      const config = new ConfigManager(testDir);
      config.initialize();
      ensureCerts(testDir, config.getInstanceName(), config.getInstanceId());

      // Create cert manager, initialize, and generate a network cert
      const mgr1 = new CertificateManager(testDir, config);
      await mgr1.initialize();
      const networkId = await mgr1.ensureNetworkCert("192.168.70.1");
      const networkDir = join(testDir, "tls", "networks", networkId);

      // Save the original network cert for comparison
      const origNetworkCert = readFileSync(join(networkDir, "server.crt"), "utf-8");

      // Regenerate the CA (this changes the CA but does NOT re-sign network certs
      // because regenerateCA() is just the CA operation)
      await mgr1.regenerateCA();

      // Verify the network cert is now orphaned (signed by old CA, not new)
      const newCACertPem = readFileSync(join(testDir, "tls", "ca.crt"), "utf-8");
      const newCACert = forge.pki.certificateFromPem(newCACertPem);
      const orphanedCert = forge.pki.certificateFromPem(origNetworkCert);
      assert.throws(() => newCACert.verify(orphanedCert),
        "Network cert should NOT verify against new CA (it's orphaned)");

      // Now simulate a fresh startup — this should auto-fix the mismatch
      const mgr2 = new CertificateManager(testDir, config);
      await mgr2.initialize();

      // The network cert should now be re-signed by the new CA
      const fixedCert = readFileSync(join(networkDir, "server.crt"), "utf-8");
      assert.notEqual(origNetworkCert, fixedCert, "Network cert should have been regenerated");

      const fixedServerCert = forge.pki.certificateFromPem(fixedCert);
      assert.doesNotThrow(() => newCACert.verify(fixedServerCert),
        "Re-signed network cert should verify against new CA");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("old-format CA migration regenerates network certs from disk (not empty cache)", async () => {
    // Simulates: user had old katulong with "Katulong Local CA" format.
    // On upgrade, migrateOldCA() should regenerate CA AND re-sign all
    // network certs by reading from disk (since metadataCache is empty).
    const testDir = mkdtempSync(join(tmpdir(), "katulong-ca-chain-test-"));
    try {
      const config = new ConfigManager(testDir);
      config.initialize();
      ensureCerts(testDir, config.getInstanceName(), config.getInstanceId());

      // Set up a network cert signed by the current (new-format) CA
      const mgr1 = new CertificateManager(testDir, config);
      await mgr1.initialize();
      const networkId = await mgr1.ensureNetworkCert("192.168.80.1");
      const networkDir = join(testDir, "tls", "networks", networkId);

      // Now replace the CA with an old-format CA to simulate upgrade scenario
      const oldKeys = forge.pki.rsa.generateKeyPair(2048);
      const oldCA = forge.pki.createCertificate();
      oldCA.publicKey = oldKeys.publicKey;
      oldCA.serialNumber = "01";
      oldCA.validity.notBefore = new Date();
      oldCA.validity.notAfter = new Date();
      oldCA.validity.notAfter.setFullYear(oldCA.validity.notBefore.getFullYear() + 10);
      const oldAttrs = [
        { name: "organizationName", value: "Katulong" },
        { name: "commonName", value: "Katulong Local CA" },
      ];
      oldCA.setSubject(oldAttrs);
      oldCA.setIssuer(oldAttrs);
      oldCA.setExtensions([
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true },
      ]);
      oldCA.sign(oldKeys.privateKey, forge.md.sha256.create());

      // Also re-sign the network cert with the old CA so the state is consistent
      // (simulating what the old version would have produced)
      const oldServerCert = mgr1.generateNetworkCert(oldCA, oldKeys.privateKey, ["192.168.80.1"]);
      const { writeFileSync: wfs } = await import("node:fs");
      wfs(join(testDir, "tls", "ca.crt"), forge.pki.certificateToPem(oldCA));
      wfs(join(testDir, "tls", "ca.key"), forge.pki.privateKeyToPem(oldKeys.privateKey), { mode: 0o600 });
      wfs(join(networkDir, "server.crt"), oldServerCert.certPem);
      wfs(join(networkDir, "server.key"), oldServerCert.keyPem, { mode: 0o600 });

      // Verify the setup: network cert IS signed by old CA
      const oldCACert = forge.pki.certificateFromPem(forge.pki.certificateToPem(oldCA));
      const oldNetworkCert = forge.pki.certificateFromPem(oldServerCert.certPem);
      assert.doesNotThrow(() => oldCACert.verify(oldNetworkCert),
        "Setup check: network cert should verify against old CA");

      // Fresh startup — migrateOldCA() detects old format, regenerates CA,
      // then re-signs network certs. validateNetworkCerts() provides safety net.
      const mgr2 = new CertificateManager(testDir, config);
      await mgr2.initialize();

      // Read the new CA (should have new format with shortid)
      const newCAPem = readFileSync(join(testDir, "tls", "ca.crt"), "utf-8");
      const newCACert = forge.pki.certificateFromPem(newCAPem);
      const cnAttr = newCACert.subject.attributes.find(a => a.name === "commonName");
      assert.ok(cnAttr.value.includes("("), "New CA should have (shortid) in CN");
      assert.notEqual(cnAttr.value, "Katulong Local CA");

      // Verify the network cert was re-signed by the new CA
      const fixedCertPem = readFileSync(join(networkDir, "server.crt"), "utf-8");
      const fixedCert = forge.pki.certificateFromPem(fixedCertPem);
      assert.doesNotThrow(() => newCACert.verify(fixedCert),
        "Network cert should verify against new CA after migration");

      // Double-check: the network cert should NOT verify against the old CA
      assert.throws(() => oldCACert.verify(fixedCert),
        "Network cert should NOT verify against old CA anymore");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

/**
 * Helper function to read CA certificate common name
 */
function readCACommonName(dataDir) {
  const caCertPath = join(dataDir, "tls", "ca.crt");
  const caCertPem = readFileSync(caCertPath, "utf-8");
  const cert = forge.pki.certificateFromPem(caCertPem);
  const cnAttr = cert.subject.attributes.find(attr => attr.name === "commonName");
  return cnAttr ? cnAttr.value : null;
}
