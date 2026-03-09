import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isServerRunning, getUrls, DATA_DIR, ROOT } from "../process-manager.js";
import envConfig from "../../env-config.js";

export default async function info() {
  const server = isServerRunning();
  const urls = getUrls();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  console.log("Katulong System Information\n");

  // Version
  console.log(`Version: ${pkg.version}`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Platform: ${process.platform} (${process.arch})`);
  console.log("");

  // Status
  console.log("Status:");
  console.log(`  Server: ${server.running ? `✓ Running (PID ${server.pid})` : "✗ Not running"}`);
  console.log("");

  // Configuration
  console.log("Configuration:");
  console.log(`  Data directory: ${DATA_DIR}`);
  console.log(`  Shell:          ${envConfig.shell}`);
  console.log("");

  // Ports
  console.log("Ports:");
  console.log(`  HTTP: ${envConfig.port}`);
  console.log("");

  // URLs (if running)
  if (server.running) {
    console.log("Access URLs:");
    console.log(`  ${urls.http}`);
  }
}
