import { isServerRunning, findPidByPort } from "../process-manager.js";
import { safeStopServer } from "../safe-stop.js";

export default async function stop(args = []) {
  const server = isServerRunning();

  if (!server.running) {
    console.log("Katulong is not running");
    return;
  }

  // If the PID file was stale/missing, resolve the actual PID from the port
  const pid = server.pid ?? findPidByPort(server.port);

  if (!pid) {
    console.error(
      `✗ Server appears to be running on port ${server.port} but could not determine its PID`,
    );
    console.error(
      `  Try: lsof -ti:${server.port} | xargs kill`,
    );
    process.exit(1);
  }

  console.log("Stopping Katulong...\n");
  console.log(`Stopping server (PID ${pid})...`);

  // Use the shared helper — it handles the launchd KeepAlive race by
  // routing through `launchctl unload` before any signals when a plist
  // exists, and polls the SPECIFIC old PID (not the port) so it can't
  // be fooled by a launchd respawn on the same port. See lib/cli/safe-stop.js
  // for the full root cause analysis (and commit 50773fc for the lesson
  // that used to live only in _finish-upgrade.js).
  const result = await safeStopServer({ pid });

  if (result.usedLaunchctl) {
    console.log("  Routed through launchctl (LaunchAgent detected)");
  }
  if (result.escalated) {
    console.log("  Process did not exit gracefully, sent SIGKILL");
  }

  if (result.stopped) {
    console.log("✓ Server stopped");
    console.log("\n✓ Katulong stopped");
    return;
  }

  console.error(`\n✗ Server may still be running${result.error ? `: ${result.error}` : ""}`);
  console.error("  Run 'katulong status' to check");
  process.exit(1);
}
