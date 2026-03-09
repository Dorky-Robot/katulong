import { isServerRunning, getUrls, detectInstallMethod } from "../process-manager.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

export default async function status() {
  const server = isServerRunning();
  const urls = getUrls();
  const version = readVersion();
  const method = detectInstallMethod();

  const methodLabels = {
    homebrew: "Homebrew",
    "npm-global": "npm (global)",
    git: "git (manual install)",
    dev: "git (development)",
  };

  console.log(`Katulong v${version} (${methodLabels[method] || method})\n`);

  // Server status
  if (server.running) {
    console.log(`✓ Server running (PID ${server.pid}, port ${server.port})`);
  } else {
    console.log("✗ Server not running");
  }

  // Show URLs if server is running
  if (server.running) {
    console.log("\nAccess URLs:");
    console.log(`  HTTP:  ${urls.http}`);
    console.log(`  SSH:   ${urls.ssh}`);
  } else {
    console.log("\nTo start Katulong, run: katulong start");
  }

  // Exit code based on status
  process.exit(server.running ? 0 : 1);
}
