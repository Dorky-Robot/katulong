import { isServerRunning } from "../process-manager.js";

export default async function stop() {
  const server = isServerRunning();

  if (!server.running) {
    console.log("Katulong is not running");
    return;
  }

  console.log("Stopping Katulong...\n");

  console.log(`Stopping server (PID ${server.pid})...`);
  try {
    process.kill(server.pid, "SIGTERM");
    // Wait for graceful shutdown (server may be draining WebSocket connections)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check if still running, force kill if necessary
    if (isServerRunning().running) {
      console.log("  Server did not stop gracefully, forcing...");
      process.kill(server.pid, "SIGKILL");
    }
    console.log("✓ Server stopped");
  } catch (err) {
    console.error(`✗ Failed to stop server: ${err.message}`);
  }

  // Final verification
  const serverCheck = isServerRunning();
  if (!serverCheck.running) {
    console.log("\n✓ Katulong stopped");
  } else {
    console.error("\n✗ Server may still be running");
    console.error("  Run 'katulong status' to check");
    process.exit(1);
  }
}
