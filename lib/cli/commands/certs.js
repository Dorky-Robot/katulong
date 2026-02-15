import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectCert, needsRegeneration, regenerateServerCert, ensureCerts, getLanIPs } from "../../tls.js";
import { DATA_DIR } from "../process-manager.js";
import { isDaemonRunning, isServerRunning } from "../process-manager.js";
import { ConfigManager } from "../../config.js";

function showHelp() {
  console.log(`
katulong certs - Manage TLS certificates

USAGE:
  katulong certs <subcommand> [options]

SUBCOMMANDS:
  info        Show certificate details and current network IPs
  check       Check if certificate needs regeneration
  regenerate  Regenerate certificates [--clean] [--yes]

OPTIONS:
  --clean     Regenerate both CA and server certificates (requires device re-import)
  --yes, -y   Skip confirmation prompt

EXAMPLES:
  katulong certs info                  # View certificate details
  katulong certs check                 # Check if regeneration needed
  katulong certs regenerate            # Regenerate server certificate only
  katulong certs regenerate --clean    # Regenerate CA and server certificates
  katulong certs regenerate --yes      # Skip confirmation prompt
`);
}

async function certsInfo() {
  console.log("Katulong TLS Certificates\n");

  // Check if TLS directory exists
  const tlsDir = join(DATA_DIR, "tls");
  if (!existsSync(tlsDir)) {
    console.log("❌ TLS certificates not initialized");
    console.log(`   Run 'katulong start' to generate certificates`);
    return;
  }

  // Inspect CA certificate
  const caCertPath = join(tlsDir, "ca.crt");
  if (existsSync(caCertPath)) {
    console.log("CA Certificate:");
    console.log(`  Location: ${caCertPath}`);
    // Could add more CA details here if needed
    console.log("");
  }

  // Inspect server certificate
  const certInfo = inspectCert(DATA_DIR);

  if (!certInfo.exists) {
    console.log("Server Certificate:");
    console.log("  ❌ Not found");
    console.log("");
  } else if (certInfo.error) {
    console.log("Server Certificate:");
    console.log(`  ❌ Invalid: ${certInfo.error}`);
    console.log("");
  } else {
    console.log("Server Certificate:");
    console.log(`  Location: ${join(tlsDir, "server.crt")}`);
    console.log(`  Valid from: ${certInfo.notBefore.toISOString()}`);
    console.log(`  Valid until: ${certInfo.notAfter.toISOString()}`);

    const now = new Date();
    const daysRemaining = Math.floor((certInfo.notAfter - now) / (1000 * 60 * 60 * 24));
    console.log(`  Days remaining: ${daysRemaining}`);
    console.log("");

    console.log("  DNS Names:");
    for (const dns of certInfo.sans.dns) {
      console.log(`    - ${dns}`);
    }
    console.log("");

    console.log("  IP Addresses:");
    for (const ip of certInfo.sans.ips) {
      console.log(`    - ${ip}`);
    }
    console.log("");
  }

  // Show current network IPs
  const currentIps = getLanIPs();
  console.log("Current Network IPs:");
  if (currentIps.length === 0) {
    console.log("  (none detected)");
  } else {
    for (const ip of currentIps) {
      const inCert = certInfo.exists && !certInfo.error && certInfo.sans.ips.includes(ip);
      const status = inCert ? "✓" : "✗";
      console.log(`  ${status} ${ip}`);
    }
  }
  console.log("");
}

async function certsCheck() {
  const status = needsRegeneration(DATA_DIR);

  if (!status.needed) {
    console.log("✓ Certificate is up to date");
    console.log(`  ${status.reason}`);
    process.exit(0);
  }

  console.log("⚠️  Certificate regeneration needed");
  console.log(`   ${status.reason}`);
  console.log("");

  console.log("Current IPs:");
  for (const ip of status.currentIps) {
    console.log(`  - ${ip}`);
  }
  console.log("");

  console.log("Certificate IPs:");
  if (status.certIps.length === 0) {
    console.log("  (none)");
  } else {
    for (const ip of status.certIps) {
      console.log(`  - ${ip}`);
    }
  }
  console.log("");

  console.log("Missing IPs:");
  for (const ip of status.missingIps) {
    console.log(`  - ${ip}`);
  }
  console.log("");

  console.log("To fix, run: katulong certs regenerate");
  process.exit(1);
}

async function certsRegenerate(args) {
  const flags = {
    clean: args.includes("--clean"),
    yes: args.includes("--yes") || args.includes("-y"),
  };

  // Check if server is running
  const daemon = isDaemonRunning();
  const server = isServerRunning();
  if (server.running) {
    console.log("⚠️  Server is currently running");
    console.log("   You will need to restart the server after regeneration");
    console.log("   Run 'katulong restart server' to apply changes");
    console.log("");
  }

  // Show what will be regenerated
  if (flags.clean) {
    console.log("Regeneration Mode: CLEAN (CA + Server)");
    console.log("");
    console.log("⚠️  WARNING: This will regenerate both CA and server certificates");
    console.log("   All devices must re-import the CA certificate to trust the server");
    console.log("");
  } else {
    console.log("Regeneration Mode: Server Only");
    console.log("");
    console.log("This will regenerate the server certificate only");
    console.log("CA certificate will be preserved (devices keep trust)");
    console.log("");
  }

  // Show preview of changes
  const status = needsRegeneration(DATA_DIR);
  const currentIps = getLanIPs();
  const certInfo = inspectCert(DATA_DIR);

  console.log("Current certificate IPs:");
  if (certInfo.exists && !certInfo.error) {
    for (const ip of certInfo.sans.ips) {
      console.log(`  - ${ip}`);
    }
  } else {
    console.log("  (none)");
  }
  console.log("");

  console.log("New certificate will include:");
  for (const ip of currentIps) {
    const isNew = !certInfo.exists || certInfo.error || !certInfo.sans.ips.includes(ip);
    const marker = isNew ? "+" : " ";
    console.log(`  ${marker} ${ip}`);
  }
  console.log("");

  // Confirm with user
  if (!flags.yes) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise((resolve) => {
      rl.question("Proceed with regeneration? (y/N) ", resolve);
    });
    rl.close();

    if (!answer.toLowerCase().startsWith("y")) {
      console.log("Aborted.");
      process.exit(0);
    }
    console.log("");
  }

  // Load instance configuration
  const configManager = new ConfigManager(DATA_DIR);
  configManager.initialize();
  const instanceName = configManager.getInstanceName();
  const instanceId = configManager.getInstanceId();

  // Perform regeneration
  try {
    if (flags.clean) {
      console.log("Regenerating CA and server certificates...");
      ensureCerts(DATA_DIR, instanceName, instanceId, { force: true });
    } else {
      console.log("Regenerating server certificate...");
      regenerateServerCert(DATA_DIR, instanceName);
    }

    console.log("✓ Certificates regenerated successfully");
    console.log("");
    console.log("Next steps:");
    if (server.running) {
      console.log("  1. Run 'katulong restart server' to apply changes");
    } else {
      console.log("  1. Run 'katulong start' to start the server with new certificates");
    }

    if (flags.clean) {
      console.log("  2. Re-import CA certificate on all devices");
      console.log("     Download from: https://your-server:3002/ca.crt");
    }
  } catch (error) {
    console.error(`❌ Regeneration failed: ${error.message}`);
    process.exit(1);
  }
}

export default async function certs(args) {
  const subcommand = args[0] || "info";

  switch (subcommand) {
    case "info":
      return await certsInfo();
    case "check":
      return await certsCheck();
    case "regenerate":
      return await certsRegenerate(args.slice(1));
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
