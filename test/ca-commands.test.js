import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import forge from "node-forge";

describe("CA Commands", () => {
  let testDir;
  let tlsDir;

  beforeEach(() => {
    // Create temporary test directory
    testDir = mkdtempSync(join(tmpdir(), "katulong-ca-test-"));
    tlsDir = join(testDir, "tls");
  });

  afterEach(() => {
    // Clean up test directory
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function generateTestCA() {
    // Generate a test CA certificate
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

    const attrs = [
      { name: "commonName", value: "Test CA" },
      { name: "organizationName", value: "Test" }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true }
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey)
    };
  }

  it("should export CA bundle in correct format", () => {
    // Setup: Create test CA
    mkdirSync(tlsDir, { recursive: true });
    const ca = generateTestCA();
    writeFileSync(join(tlsDir, "ca.crt"), ca.cert);
    writeFileSync(join(tlsDir, "ca.key"), ca.key);

    // Execute export (use KATULONG_DATA_DIR, not DATA_DIR)
    const output = execSync(`KATULONG_DATA_DIR=${testDir} node bin/katulong ca export`, {
      cwd: process.cwd(),
      encoding: 'utf-8'
    });

    // Validate output is base64
    assert.ok(output.trim().length > 0, "Export should produce output");
    const buffer = Buffer.from(output.trim(), 'base64');
    const json = buffer.toString('utf-8');
    const bundle = JSON.parse(json);

    // Validate bundle structure
    assert.strictEqual(bundle.version, 1, "Bundle should have version 1");
    assert.ok(bundle.ca, "Bundle should have ca field");
    assert.ok(bundle.ca.cert, "Bundle should have ca.cert");
    assert.ok(bundle.ca.key, "Bundle should have ca.key");
    assert.ok(bundle.fingerprint, "Bundle should have fingerprint");
    assert.ok(bundle.exportedAt, "Bundle should have exportedAt");
    assert.ok(bundle.exportedFrom, "Bundle should have exportedFrom");

    // Validate cert/key are PEM format
    assert.ok(bundle.ca.cert.includes("BEGIN CERTIFICATE"), "Cert should be PEM format");
    assert.ok(bundle.ca.key.includes("BEGIN RSA PRIVATE KEY"), "Key should be PEM format");
  });

  it("should detect same CA on import", () => {
    // Setup: Create test CA and export it
    mkdirSync(tlsDir, { recursive: true });
    const ca = generateTestCA();
    writeFileSync(join(tlsDir, "ca.crt"), ca.cert);
    writeFileSync(join(tlsDir, "ca.key"), ca.key);

    const bundle = execSync(`KATULONG_DATA_DIR=${testDir} node bin/katulong ca export`, {
      cwd: process.cwd(),
      encoding: 'utf-8'
    });

    // Try to import the same CA
    const output = execSync(`echo '${bundle}' | KATULONG_DATA_DIR=${testDir} node bin/katulong ca import`, {
      cwd: process.cwd(),
      encoding: 'utf-8'
    });

    // Should detect same CA
    assert.ok(output.includes("CA fingerprints match"), "Should detect matching fingerprints");
    assert.ok(output.includes("no action needed"), "Should not require action");
  });

  it("should validate CA bundle structure", () => {
    // Setup: Create test directory
    mkdirSync(tlsDir, { recursive: true });

    // Create invalid bundle (missing key)
    const invalidBundle = Buffer.from(JSON.stringify({
      version: 1,
      ca: {
        cert: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----"
        // Missing key
      }
    })).toString('base64');

    // Try to import invalid bundle
    try {
      execSync(`echo '${invalidBundle}' | KATULONG_DATA_DIR=${testDir} node bin/katulong ca import`, {
        cwd: process.cwd(),
        encoding: 'utf-8'
      });
      assert.fail("Should have thrown error for invalid bundle");
    } catch (error) {
      assert.ok(error.message.includes("Invalid CA bundle"), "Should reject invalid bundle");
    }
  });

  it.skip("should backup existing CA before import", () => {
    // Setup: Create initial CA
    mkdirSync(tlsDir, { recursive: true });
    const oldCA = generateTestCA();
    writeFileSync(join(tlsDir, "ca.crt"), oldCA.cert);
    writeFileSync(join(tlsDir, "ca.key"), oldCA.key);

    // Create new CA by exporting it then modifying
    const newCA = generateTestCA();

    // Calculate proper fingerprint
    const cert = forge.pki.certificateFromPem(newCA.cert);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const hash = createHash('sha256').update(der, 'binary').digest('hex');
    const fingerprint = 'SHA256:' + hash.match(/.{2}/g).join(':');

    const newBundle = {
      version: 1,
      ca: newCA,
      fingerprint,
      exportedAt: new Date().toISOString(),
      exportedFrom: "test"
    };
    const bundleB64 = Buffer.from(JSON.stringify(newBundle)).toString('base64');

    // Import with --yes flag (skip confirmation)
    execSync(`echo '${bundleB64}' | KATULONG_DATA_DIR=${testDir} node bin/katulong ca import --yes`, {
      cwd: process.cwd(),
      encoding: 'utf-8'
    });

    // Verify backup was created
    const backupFiles = readdirSync(tlsDir).filter(f => f.includes('backup'));
    assert.ok(backupFiles.length >= 2, "Should create backup files for cert and key");
    assert.ok(backupFiles.some(f => f.startsWith('ca.crt.backup')), "Should backup cert");
    assert.ok(backupFiles.some(f => f.startsWith('ca.key.backup')), "Should backup key");
  });
});
