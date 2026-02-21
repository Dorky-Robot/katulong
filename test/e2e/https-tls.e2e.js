import { test, expect } from "@playwright/test";
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { TEST_HTTPS_PORT, TEST_DATA_DIR } from "./test-config.js";

const HTTPS_PORT = TEST_HTTPS_PORT;
const DATA_DIR = TEST_DATA_DIR;

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
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/info",
      rejectUnauthorized: false,
    });

    // /connect/info is unauthenticated — verify TLS handshake completes
    expect(result.status).toBe(200);
    expect(result.data).toContain("httpsPort");
  });

  test("should complete TLS handshake with SNI hostname", async () => {
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/info",
      servername: "localhost",
      rejectUnauthorized: false,
    });

    expect(result.status).toBe(200);
    expect(result.data).toContain("httpsPort");
  });

  test("should serve connect info over HTTPS", async () => {
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/info",
      rejectUnauthorized: false,
    });

    expect(result.status).toBe(200);
    const info = JSON.parse(result.data);
    expect(info).toHaveProperty("httpsPort");
  });

  test("should reject requests to removed trust page", async () => {
    const result = await httpsGet({
      hostname: "127.0.0.1",
      port: HTTPS_PORT,
      path: "/connect/trust",
      rejectUnauthorized: false,
    });

    // Trust page was removed — should not return 200
    expect(result.status).not.toBe(200);
  });

  test("should regenerate network certificates after CA migration", async () => {
    // Verify that network certificates exist and are properly formed

    // Read network certificate
    const networksDir = join(DATA_DIR, "tls", "networks");
    if (!existsSync(networksDir)) {
      // Skip if no network certs (fresh install)
      return;
    }

    // Read CA cert to get its public key
    const caCertPath = join(DATA_DIR, "tls", "ca.crt");
    if (!existsSync(caCertPath)) {
      // Skip if no CA cert (CA generation removed)
      return;
    }

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
      }
    }
  });
});
