import stop from "./stop.js";
import start from "./start.js";

export default async function restart(args) {
  const target = args.find(arg => !arg.startsWith("--")) || "both";

  // Validate target
  if (!["daemon", "server", "both"].includes(target)) {
    console.error(`Error: Invalid target '${target}'`);
    console.error("Usage: katulong restart [daemon|server|both] [--foreground]");
    process.exit(1);
  }

  console.log(`Restarting ${target === "both" ? "Katulong" : target}...\n`);
  await stop(args);
  console.log(""); // Blank line
  await start(args);
}
