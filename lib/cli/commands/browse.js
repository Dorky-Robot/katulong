import { exec } from "node:child_process";
import { isServerRunning, getUrls } from "../process-manager.js";

export default async function open() {
  const server = isServerRunning();

  if (!server.running) {
    console.error("Error: Katulong server is not running");
    console.error("Start it with: katulong start");
    process.exit(1);
  }

  const urls = getUrls();
  const url = urls.http;

  console.log(`Opening ${url}...`);

  // Detect OS and use appropriate open command
  const platform = process.platform;
  const openCmd =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";

  exec(`${openCmd} "${url}"`, (err) => {
    if (err) {
      console.error(`Failed to open browser: ${err.message}`);
      console.error(`\nPlease open manually: ${url}`);
      process.exit(1);
    }
  });
}
