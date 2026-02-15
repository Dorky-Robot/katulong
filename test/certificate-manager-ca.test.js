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
    assert.strictEqual(initialCaCert, `${initialInstanceName} Local CA`);

    // Change instance name
    configManager.setInstanceName("New Instance");

    // Regenerate CA
    await certManager.regenerateCA();

    // Verify CA has new instance name
    const newCaCert = readCACommonName(testDataDir);
    assert.strictEqual(newCaCert, "New Instance Local CA");
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
