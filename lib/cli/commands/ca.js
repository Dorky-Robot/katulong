import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import forge from "node-forge";
import { DATA_DIR } from "../process-manager.js";
import { isServerRunning } from "../process-manager.js";

function showHelp() {
  console.log(`
katulong ca - Manage Certificate Authority

USAGE:
  katulong ca <subcommand> [options]

SUBCOMMANDS:
  info       Show CA certificate details and fingerprint
  export     Export CA certificate and key (base64-encoded)
  import     Import CA certificate and key from stdin

OPTIONS:
  --yes, -y  Skip confirmation prompts

EXAMPLES:
  katulong ca info                      # View CA details
  katulong ca export                    # Export CA to stdout
  katulong ca export > ca-bundle.txt    # Save to file
  katulong ca import < ca-bundle.txt    # Import from file

CA SHARING WORKFLOW:
  On first instance (source):
    $ katulong ca export > ca-bundle.txt
    $ scp ca-bundle.txt user@other-host:/tmp/

  On other instance (destination):
    $ katulong ca import < /tmp/ca-bundle.txt
    $ katulong restart

This allows multiple Katulong instances to share the same CA,
so devices only need to trust one certificate.
`);
}

function calculateFingerprint(certPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const hash = createHash('sha256').update(der, 'binary').digest('hex');
  // Format as SHA256:XX:XX:XX:...
  return 'SHA256:' + hash.match(/.{2}/g).join(':');
}

async function caInfo() {
  console.log("Certificate Authority\n");

  const tlsDir = join(DATA_DIR, "tls");
  const caCertPath = join(tlsDir, "ca.crt");
  const caKeyPath = join(tlsDir, "ca.key");

  if (!existsSync(caCertPath)) {
    console.log("❌ CA certificate not found");
    console.log(`   Location: ${caCertPath}`);
    console.log(`   Run 'katulong start' to generate CA`);
    return;
  }

  try {
    const certPem = readFileSync(caCertPath, "utf-8");
    const cert = forge.pki.certificateFromPem(certPem);
    const fingerprint = calculateFingerprint(certPem);

    console.log("CA Certificate:");
    console.log(`  Location: ${caCertPath}`);
    console.log(`  Subject: ${cert.subject.getField('CN')?.value || 'N/A'}`);
    console.log(`  Valid from: ${cert.validity.notBefore.toISOString()}`);
    console.log(`  Valid until: ${cert.validity.notAfter.toISOString()}`);

    const now = new Date();
    const daysRemaining = Math.floor((cert.validity.notAfter - now) / (1000 * 60 * 60 * 24));
    console.log(`  Days remaining: ${daysRemaining}`);
    console.log("");

    console.log(`  Fingerprint: ${fingerprint}`);
    console.log("");

    if (existsSync(caKeyPath)) {
      console.log("CA Private Key:");
      console.log(`  Location: ${caKeyPath}`);
      console.log(`  ⚠️  Keep this file secure - it can sign certificates`);
    } else {
      console.log("⚠️  CA private key not found");
    }
  } catch (error) {
    console.error(`❌ Error reading CA: ${error.message}`);
    process.exit(1);
  }
}

async function caExport() {
  const tlsDir = join(DATA_DIR, "tls");
  const caCertPath = join(tlsDir, "ca.crt");
  const caKeyPath = join(tlsDir, "ca.key");

  // Validate CA exists
  if (!existsSync(caCertPath) || !existsSync(caKeyPath)) {
    console.error("❌ CA certificate or key not found");
    console.error(`   Expected at: ${caCertPath}`);
    console.error(`   Run 'katulong start' to generate CA`);
    process.exit(1);
  }

  try {
    const certPem = readFileSync(caCertPath, "utf-8");
    const keyPem = readFileSync(caKeyPath, "utf-8");
    const fingerprint = calculateFingerprint(certPem);

    const bundle = {
      version: 1,
      ca: {
        cert: certPem,
        key: keyPem
      },
      fingerprint,
      exportedAt: new Date().toISOString(),
      exportedFrom: hostname()
    };

    // Encode as base64 for easy copy/paste
    const json = JSON.stringify(bundle, null, 2);
    const base64 = Buffer.from(json).toString('base64');

    // Output to stdout (can be piped to file or clipboard)
    console.log(base64);
  } catch (error) {
    console.error(`❌ Export failed: ${error.message}`);
    process.exit(1);
  }
}

async function caImport(args) {
  const flags = {
    yes: args.includes("--yes") || args.includes("-y")
  };

  const tlsDir = join(DATA_DIR, "tls");
  const caCertPath = join(tlsDir, "ca.crt");
  const caKeyPath = join(tlsDir, "ca.key");

  // Check if server is running
  const server = isServerRunning();
  if (server.running) {
    console.log("⚠️  Server is currently running");
    console.log("   You will need to restart the server after import");
    console.log("");
  }

  // Read from stdin
  console.error("Reading CA bundle from stdin...");
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const input = Buffer.concat(chunks).toString('utf-8').trim();

  if (!input) {
    console.error("❌ No input received");
    console.error("   Usage: katulong ca import < ca-bundle.txt");
    process.exit(1);
  }

  // Decode and validate
  let bundle;
  try {
    // Decode base64
    const json = Buffer.from(input, 'base64').toString('utf-8');
    bundle = JSON.parse(json);

    // Validate structure
    if (!bundle.version || bundle.version !== 1) {
      throw new Error("Invalid or unsupported bundle version");
    }
    if (!bundle.ca?.cert || !bundle.ca?.key) {
      throw new Error("Missing certificate or key in bundle");
    }

    // Validate certificate
    const cert = forge.pki.certificateFromPem(bundle.ca.cert);
    const key = forge.pki.privateKeyFromPem(bundle.ca.key);

    // Verify it's a CA certificate
    const basicConstraints = cert.getExtension('basicConstraints');
    if (!basicConstraints || !basicConstraints.cA) {
      throw new Error("Certificate is not a CA certificate");
    }

    // Verify key matches certificate
    const publicKeyPem = forge.pki.publicKeyToPem(cert.publicKey);
    const derivedPublicKeyPem = forge.pki.publicKeyToPem(forge.pki.rsa.setPublicKey(key.n, key.e));
    if (publicKeyPem !== derivedPublicKeyPem) {
      throw new Error("Private key does not match certificate");
    }

    // Calculate fingerprint
    bundle.calculatedFingerprint = calculateFingerprint(bundle.ca.cert);
  } catch (error) {
    console.error(`❌ Invalid CA bundle: ${error.message}`);
    process.exit(1);
  }

  // Show details
  console.log("\nCA Bundle Details:");
  console.log(`  Fingerprint: ${bundle.calculatedFingerprint}`);
  console.log(`  Exported from: ${bundle.exportedFrom}`);
  console.log(`  Exported at: ${bundle.exportedAt}`);
  console.log("");

  // Check if CA already exists
  if (existsSync(caCertPath)) {
    const existingCert = readFileSync(caCertPath, "utf-8");
    const existingFingerprint = calculateFingerprint(existingCert);

    console.log("⚠️  CA certificate already exists");
    console.log(`   Current fingerprint: ${existingFingerprint}`);
    console.log(`   New fingerprint: ${bundle.calculatedFingerprint}`);
    console.log("");

    if (existingFingerprint === bundle.calculatedFingerprint) {
      console.log("✓ CA fingerprints match - no action needed");
      process.exit(0);
    }

    console.log("⚠️  WARNING: Replacing CA will invalidate all existing network certificates");
    console.log("   All network certificates will need to be regenerated");
    console.log("   Devices that trusted the old CA will need to trust the new CA");
    console.log("");
  }

  // Confirm with user
  if (!flags.yes) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise((resolve) => {
      rl.question("Import this CA certificate? (y/N) ", resolve);
    });
    rl.close();

    if (!answer.toLowerCase().startsWith("y")) {
      console.log("Aborted.");
      process.exit(0);
    }
    console.log("");
  }

  // Backup existing CA if present
  if (existsSync(caCertPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupCertPath = `${caCertPath}.backup-${timestamp}`;
    const backupKeyPath = `${caKeyPath}.backup-${timestamp}`;

    console.log("Backing up existing CA...");
    renameSync(caCertPath, backupCertPath);
    renameSync(caKeyPath, backupKeyPath);
    console.log(`  Backup: ${backupCertPath}`);
    console.log("");
  }

  // Write new CA
  try {
    writeFileSync(caCertPath, bundle.ca.cert);
    writeFileSync(caKeyPath, bundle.ca.key, { mode: 0o600 });

    console.log("✓ CA certificate imported successfully");
    console.log("");
    console.log("Next steps:");
    console.log("  1. Restart Katulong: katulong restart");
    console.log("  2. Network certificates will be regenerated automatically");
    console.log("  3. Devices may need to re-trust the CA certificate");
    console.log("     Download from: https://your-server:3100/connect/trust");
  } catch (error) {
    console.error(`❌ Import failed: ${error.message}`);
    process.exit(1);
  }
}

export default async function ca(args) {
  const subcommand = args[0] || "info";

  switch (subcommand) {
    case "info":
      return await caInfo();
    case "export":
      return await caExport();
    case "import":
      return await caImport(args.slice(1));
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      console.error(`Error: Unknown subcommand '${subcommand}'`);
      showHelp();
      process.exit(1);
  }
}
