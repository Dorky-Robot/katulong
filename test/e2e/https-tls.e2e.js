import { test, expect } from "@playwright/test";
import https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
});
