import forge from "node-forge";
import { networkInterfaces, hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

const CA_YEARS = 10;
const SERVER_YEARS = 2;

let deprecationWarned = false;

function warnDeprecated() {
  if (deprecationWarned) return;
  deprecationWarned = true;
  log.warn(
    "[DEPRECATED] LAN TLS (auto-generated certificates) is deprecated and will be removed in a future release. " +
    "Use a tunnel service instead (e.g. cloudflared, ngrok) for secure remote access without managing certificates.",
  );
}

export function getLanIPs() {
  const ips = [];
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.family === "IPv4") ips.push(iface.address);
    }
  }
  return ips;
}

export function generateCA(instanceName, instanceId) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + CA_YEARS,
  );

  // Include "Katulong" and instance ID in CN to make each CA unique and identifiable
  // Format CN: "Katulong - InstanceName (shortid)"
  // Format Org: "InstanceName"
  const shortId = instanceId.substring(0, 8);

  const attrs = [
    { name: "organizationName", value: instanceName },
    { name: "commonName", value: `Katulong - ${instanceName} (${shortId})` },
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

  const lanIPs = getLanIPs();
  const primaryHost = lanIPs[0] || "localhost";
  const attrs = [
    { name: "organizationName", value: instanceName },
    { name: "commonName", value: primaryHost },
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

/**
 * Inspect an existing certificate and extract metadata
 * @param {string} dataDir - Path to data directory
 * @returns {object} Certificate metadata or { exists: false } if not found
 */
export function inspectCert(dataDir) {
  const certPath = join(dataDir, "tls", "server.crt");

  if (!existsSync(certPath)) {
    return { exists: false };
  }

  try {
    const certPem = readFileSync(certPath, "utf-8");
    const cert = forge.pki.certificateFromPem(certPem);

    // Extract SANs (Subject Alternative Names)
    const sanExt = cert.getExtension("subjectAltName");
    const ips = [];
    const dns = [];

    if (sanExt && sanExt.altNames) {
      for (const altName of sanExt.altNames) {
        if (altName.type === 7) {
          // IP address
          ips.push(altName.ip);
        } else if (altName.type === 2) {
          // DNS name
          dns.push(altName.value);
        }
      }
    }

    return {
      exists: true,
      notBefore: cert.validity.notBefore,
      notAfter: cert.validity.notAfter,
      sans: { ips, dns },
    };
  } catch (error) {
    return {
      exists: true,
      error: error.message,
    };
  }
}

/**
 * Check if certificate needs regeneration based on current network IPs
 * @param {string} dataDir - Path to data directory
 * @returns {object} Status with needed flag and details
 */
export function needsRegeneration(dataDir) {
  const currentIps = getLanIPs();
  const certInfo = inspectCert(dataDir);

  if (!certInfo.exists) {
    return {
      needed: true,
      reason: "Certificate does not exist",
      currentIps,
      certIps: [],
      missingIps: currentIps,
    };
  }

  if (certInfo.error) {
    return {
      needed: true,
      reason: `Certificate is invalid: ${certInfo.error}`,
      currentIps,
      certIps: [],
      missingIps: currentIps,
    };
  }

  const certIps = certInfo.sans.ips;
  const missingIps = currentIps.filter((ip) => !certIps.includes(ip));

  return {
    needed: missingIps.length > 0,
    reason: missingIps.length > 0
      ? `Current IP(s) ${missingIps.join(", ")} not in certificate SANs`
      : "Certificate is up to date",
    currentIps,
    certIps,
    missingIps,
  };
}

/**
 * Regenerate server certificate only (preserves CA)
 * @param {string} dataDir - Path to data directory
 * @param {string} instanceName - Instance name for certificate
 * @returns {object} Paths to regenerated certificates
 */
export function regenerateServerCert(dataDir, instanceName) {
  const tlsDir = join(dataDir, "tls");
  const paths = {
    caCert: join(tlsDir, "ca.crt"),
    caKey: join(tlsDir, "ca.key"),
    serverCert: join(tlsDir, "server.crt"),
    serverKey: join(tlsDir, "server.key"),
  };

  // Ensure CA exists
  if (!existsSync(paths.caCert) || !existsSync(paths.caKey)) {
    throw new Error(
      "CA certificate not found. Use --clean to regenerate both CA and server certificates.",
    );
  }

  // Read existing CA
  const caCertPem = readFileSync(paths.caCert, "utf-8");
  const caKeyPem = readFileSync(paths.caKey, "utf-8");
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  // Generate new server certificate
  const server = generateServerCert(caCert, caKey, instanceName);

  // Write to temp files first (atomic write)
  const serverCertTmp = join(tlsDir, "server.crt.tmp");
  const serverKeyTmp = join(tlsDir, "server.key.tmp");

  writeFileSync(serverCertTmp, server.certPem);
  writeFileSync(serverKeyTmp, server.keyPem, { mode: 0o600 });

  // Atomic rename
  renameSync(serverCertTmp, paths.serverCert);
  renameSync(serverKeyTmp, paths.serverKey);

  // Ensure correct permissions
  try {
    chmodSync(paths.serverKey, 0o600);
  } catch {
    // Best-effort on platforms that don't support chmod
  }

  return paths;
}

export function generateMobileConfig(caCertPem, instanceName, instanceId) {
  // Extract DER bytes from PEM and base64-encode for the plist
  const certDer = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(caCertPem))).getBytes(),
  );

  const payloadUUID = randomUUID().toUpperCase();
  const profileUUID = randomUUID().toUpperCase();

  // Use first 8 chars of instance ID to make identifiers unique
  const shortId = instanceId.substring(0, 8);

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
      <string>Adds the ${instanceName} Local CA root certificate (ID: ${shortId})</string>
      <key>PayloadDisplayName</key>
      <string>${instanceName} Local CA (${shortId})</string>
      <key>PayloadIdentifier</key>
      <string>com.katulong.ca.${shortId}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${payloadUUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>${instanceName} Local CA (${shortId})</string>
  <key>PayloadDescription</key>
  <string>Install this profile to trust the ${instanceName} (ID: ${shortId}) local server certificate.</string>
  <key>PayloadIdentifier</key>
  <string>com.katulong.profile.${shortId}</string>
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

export function ensureCerts(dataDir, instanceName, instanceId, options = {}) {
  warnDeprecated();
  const { force = false } = options;

  const tlsDir = join(dataDir, "tls");
  const paths = {
    caCert: join(tlsDir, "ca.crt"),
    caKey: join(tlsDir, "ca.key"),
    serverCert: join(tlsDir, "server.crt"),
    serverKey: join(tlsDir, "server.key"),
  };

  // If not forcing regeneration and certs exist, return existing
  if (!force && existsSync(paths.caCert) && existsSync(paths.serverCert)) {
    return paths;
  }

  mkdirSync(tlsDir, { recursive: true });

  const ca = generateCA(instanceName, instanceId);
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
