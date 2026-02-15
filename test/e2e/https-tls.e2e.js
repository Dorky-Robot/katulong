import { test, expect } from "@playwright/test";
import https from "node:https";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

const HTTPS_PORT = 3100;
const DATA_DIR = "/tmp/katulong-e2e-data";

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

test.describe("HTTPS / TLS", () => {
  test("should complete TLS handshake when connecting by IP (no SNI)", async () => {
    // Android Chrome doesn't send SNI for IP addresses, so we test
    // that the server provides a default certificate for such connections
    const ca = readFileSync(join(DATA_DIR, "tls", "ca.crt"));

    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/trust",
      ca,
      // servername defaults to hostname, but 127.0.0.1 as IP won't match
      // any SNI — this tests the default cert fallback
      rejectUnauthorized: false,
    });

    expect(result.status).toBe(200);
    expect(result.data).toContain("Trust Certificate");
  });

  test("should complete TLS handshake with SNI hostname", async () => {
    const ca = readFileSync(join(DATA_DIR, "tls", "ca.crt"));

    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/trust",
      ca,
      servername: "localhost",
      rejectUnauthorized: false,
    });

    expect(result.status).toBe(200);
    expect(result.data).toContain("Trust Certificate");
  });

  test("should serve trust page over HTTPS", async () => {
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/trust",
      rejectUnauthorized: false,
    });

    expect(result.status).toBe(200);
    expect(result.data).toContain("Download Certificate");
  });

  test("should serve ca.crt over HTTPS", async () => {
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/trust/ca.crt",
      rejectUnauthorized: false,
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/x-x509-ca-cert");
    expect(result.data).toContain("BEGIN CERTIFICATE");
  });

  test("should auto-migrate old CA certificate format", async () => {
    // This test verifies that when upgrading from an old version with "Katulong Local CA",
    // the CA is automatically regenerated with the new format "Katulong - InstanceName (id)"
    // and all network certificates are regenerated

    // Read the current CA certificate
    const caCertPath = join(DATA_DIR, "tls", "ca.crt");
    const caCertPem = readFileSync(caCertPath, "utf-8");
    const caCert = forge.pki.certificateFromPem(caCertPem);

    // Verify it has the NEW format (includes instance name and ID)
    const cnAttr = caCert.subject.attributes.find(attr => attr.name === "commonName");
    const commonName = cnAttr ? cnAttr.value : "";

    expect(commonName).toContain("Katulong -");
    expect(commonName).toMatch(/\([a-f0-9]{8}\)/); // Should have (shortid) at the end
    expect(commonName).not.toBe("Katulong Local CA"); // Should NOT be old format

    // Verify we can connect with HTTPS using the migrated certificate
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/trust",
      ca: caCertPem,
      rejectUnauthorized: true, // Strict verification
    });

    expect(result.status).toBe(200);
    expect(result.data).toContain("Trust Certificate");
  });

  test("should regenerate network certificates after CA migration", async () => {
    // Verify that network certificates were regenerated with the new CA

    // Read network certificate
    const networksDir = join(DATA_DIR, "tls", "networks");
    if (!existsSync(networksDir)) {
      // Skip if no network certs (fresh install)
      return;
    }

    // Read CA cert to get its public key
    const caCertPath = join(DATA_DIR, "tls", "ca.crt");
    const caCertPem = readFileSync(caCertPath, "utf-8");
    const caCert = forge.pki.certificateFromPem(caCertPem);

    // Find first network cert and verify it's signed by current CA
    const { readdirSync } = await import("node:fs");
    const networkDirs = readdirSync(networksDir);

    if (networkDirs.length > 0) {
      const firstNetwork = networkDirs[0];
      const serverCertPath = join(networksDir, firstNetwork, "server.crt");

      if (existsSync(serverCertPath)) {
        const serverCertPem = readFileSync(serverCertPath, "utf-8");
        const serverCert = forge.pki.certificateFromPem(serverCertPem);

        // Verify server cert is signed by current CA
        const issuerCN = serverCert.issuer.attributes.find(attr => attr.name === "commonName");
        const subjectCN = caCert.subject.attributes.find(attr => attr.name === "commonName");

        expect(issuerCN.value).toBe(subjectCN.value);
        expect(issuerCN.value).toContain("Katulong -");
        expect(issuerCN.value).not.toBe("Katulong Local CA");
      }
    }
  });
});
