import forge from "node-forge";
import { networkInterfaces, hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const CA_YEARS = 10;
const SERVER_YEARS = 2;

function getLanIPs() {
  const ips = [];
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.family === "IPv4") ips.push(iface.address);
    }
  }
  return ips;
}

function generateCA(instanceName) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + CA_YEARS,
  );

  const attrs = [
    { name: "organizationName", value: instanceName },
    { name: "commonName", value: `${instanceName} Local CA` },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert,
    key: keys.privateKey,
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function generateServerCert(caCert, caKey, instanceName) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + SERVER_YEARS,
  );

  const attrs = [
    { name: "organizationName", value: instanceName },
    { name: "commonName", value: "localhost" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);

  // Build SANs: localhost, loopback, all LAN IPs, hostname.local
  const altNames = [
    { type: 2, value: "localhost" }, // DNS
    { type: 7, ip: "127.0.0.1" }, // IP
    { type: 7, ip: "::1" }, // IPv6 loopback
  ];

  const localHost = hostname();
  if (localHost) {
    altNames.push({ type: 2, value: localHost });
    altNames.push({ type: 2, value: `${localHost}.local` });
  }

  // Always include katulong.local for LAN device onboarding
  altNames.push({ type: 2, value: "katulong.local" });

  for (const ip of getLanIPs()) {
    altNames.push({ type: 7, ip });
  }

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
    },
    {
      name: "subjectAltName",
      altNames,
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function generateMobileConfig(caCertPem, instanceName) {
  // Extract DER bytes from PEM and base64-encode for the plist
  const certDer = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(caCertPem))).getBytes(),
  );

  const payloadUUID = randomUUID().toUpperCase();
  const profileUUID = randomUUID().toUpperCase();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ca.crt</string>
      <key>PayloadContent</key>
      <data>${certDer}</data>
      <key>PayloadDescription</key>
      <string>Adds the ${instanceName} Local CA root certificate</string>
      <key>PayloadDisplayName</key>
      <string>${instanceName} Local CA</string>
      <key>PayloadIdentifier</key>
      <string>com.katulong.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${payloadUUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>${instanceName} Local CA</string>
  <key>PayloadDescription</key>
  <string>Install this profile to trust the ${instanceName} local server certificate.</string>
  <key>PayloadIdentifier</key>
  <string>com.katulong.profile</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>`;
}

export function ensureCerts(dataDir, instanceName) {
  const tlsDir = join(dataDir, "tls");
  const paths = {
    caCert: join(tlsDir, "ca.crt"),
    caKey: join(tlsDir, "ca.key"),
    serverCert: join(tlsDir, "server.crt"),
    serverKey: join(tlsDir, "server.key"),
  };

  if (existsSync(paths.caCert) && existsSync(paths.serverCert)) {
    return paths;
  }

  mkdirSync(tlsDir, { recursive: true });

  const ca = generateCA(instanceName);
  const server = generateServerCert(ca.cert, ca.key, instanceName);

  writeFileSync(paths.caCert, ca.certPem);
  writeFileSync(paths.caKey, ca.keyPem, { mode: 0o600 });
  writeFileSync(paths.serverCert, server.certPem);
  writeFileSync(paths.serverKey, server.keyPem, { mode: 0o600 });

  // Restrict key file permissions
  try {
    chmodSync(paths.caKey, 0o600);
    chmodSync(paths.serverKey, 0o600);
  } catch {
    // Best-effort on platforms that don't support chmod
  }

  return paths;
}
