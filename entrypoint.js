import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const children = [];

function spawnChild(script) {
  const child = fork(join(__dirname, script), { stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
  return child;
}

function shutdown() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

spawnChild("daemon.js");

setTimeout(() => {
  spawnChild("server.js");
}, 500);
