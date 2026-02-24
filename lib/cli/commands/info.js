import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDaemonRunning, isServerRunning, getUrls, DATA_DIR, SOCKET_PATH, PID_PATH, ROOT } from "../process-manager.js";
import envConfig from "../../env-config.js";

export default async function info() {
  const daemon = isDaemonRunning();
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
  console.log(`  Daemon: ${daemon.running ? `✓ Running (PID ${daemon.pid})` : "✗ Not running"}`);
  console.log(`  Server: ${server.running ? `✓ Running (PID ${server.pid})` : "✗ Not running"}`);
  console.log("");

  // Configuration
  console.log("Configuration:");
  console.log(`  Data directory: ${DATA_DIR}`);
  console.log(`  Socket path:    ${SOCKET_PATH}`);
  console.log(`  PID file:       ${PID_PATH}`);
  console.log(`  Shell:          ${envConfig.shell}`);
  console.log("");

  // Ports
  console.log("Ports:");
  console.log(`  HTTP: ${envConfig.port}`);
  console.log(`  SSH:  ${envConfig.sshPort}`);
  console.log("");

  // URLs (if running)
  if (server.running) {
    console.log("Access URLs:");
    console.log(`  ${urls.http}`);
    console.log(`  ${urls.ssh}`);
  }
}
