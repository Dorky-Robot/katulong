import { isDaemonRunning, isServerRunning, getUrls } from "../process-manager.js";

export default async function status() {
  const daemon = isDaemonRunning();
  const server = isServerRunning();
  const urls = getUrls();

  console.log("Katulong Status\n");

  // Daemon status
  if (daemon.running) {
    console.log(`✓ Daemon running (PID ${daemon.pid}, detected via ${daemon.method})`);
  } else {
    console.log("✗ Daemon not running");
  }

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
    console.log(`  HTTPS: ${urls.https}`);
    console.log(`  SSH:   ${urls.ssh}`);
  } else {
    console.log("\nTo start Katulong, run: katulong start");
  }

  // Exit code based on status
  process.exit(daemon.running && server.running ? 0 : 1);
}
