/**
 * CLI: katulong extensions <subcommand>
 *
 * Manages tile extensions in ~/.katulong/extensions/.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { formatTable } from "../format.js";

const EXTENSIONS_DIR = join(homedir(), ".katulong", "extensions");

function usage() {
  console.log(`
Usage: katulong extensions <subcommand> [options]

Subcommands:
  list                    List installed extensions
  install <repo>          Install an extension from a git repo
  remove <name>           Remove an installed extension

Options:
  --json                  Output as JSON
`);
}

function ensureExtensionsDir() {
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
}

async function list(args) {
  const jsonMode = args.includes("--json");
  ensureExtensionsDir();

  const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  const extensions = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = join(EXTENSIONS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      extensions.push({
        name: manifest.name || entry.name,
        type: manifest.type || "unknown",
        version: manifest.version || "-",
        description: manifest.description || "",
        dir: entry.name,
      });
    } catch {
      extensions.push({
        name: entry.name,
        type: "unknown",
        version: "-",
        description: "(invalid manifest)",
        dir: entry.name,
      });
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ extensions }, null, 2));
    return;
  }

  if (extensions.length === 0) {
    console.log("No extensions installed.");
    console.log(`\nInstall one with: katulong extensions install <repo>`);
    return;
  }

  const rows = extensions.map(e => [e.name, e.type, e.version, e.description]);
  process.stdout.write(formatTable(["NAME", "TYPE", "VERSION", "DESCRIPTION"], rows));
}

async function install(args) {
  const jsonMode = args.includes("--json");
  const repo = args.find(a => a !== "--json");
  if (!repo) {
    console.error("Usage: katulong extensions install <repo>");
    console.error("\nExamples:");
    console.error("  katulong extensions install https://github.com/user/katulong-tile-example.git");
    console.error("  katulong extensions install user/katulong-tile-example");
    process.exit(1);
  }

  ensureExtensionsDir();

  // If repo is in "user/repo" format, convert to GitHub URL
  let repoUrl = repo;
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    repoUrl = `https://github.com/${repo}.git`;
  }

  // Derive directory name from repo URL
  const repoName = basename(repoUrl, ".git").replace(/^katulong-tile-/, "");
  const targetDir = join(EXTENSIONS_DIR, repoName);

  if (existsSync(targetDir)) {
    console.error(`Extension directory already exists: ${repoName}`);
    console.error("Remove it first: katulong extensions remove " + repoName);
    process.exit(1);
  }

  console.log(`Installing from ${repoUrl}...`);

  try {
    await new Promise((resolve, reject) => {
      execFile("git", ["clone", "--depth", "1", repoUrl, targetDir], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });
  } catch (err) {
    console.error(`Failed to clone: ${err.message}`);
    process.exit(1);
  }

  // Verify manifest.json exists
  const manifestPath = join(targetDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("Cloned repo is missing manifest.json — not a valid extension.");
    rmSync(targetDir, { recursive: true, force: true });
    process.exit(1);
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (jsonMode) {
      console.log(JSON.stringify({ installed: manifest }, null, 2));
    } else {
      console.log(`\nInstalled: ${manifest.name || repoName}`);
      if (manifest.description) console.log(`  ${manifest.description}`);
      console.log(`  Type: ${manifest.type || "unknown"}`);
      console.log(`  Version: ${manifest.version || "-"}`);
      console.log(`\nRestart Katulong to load the extension.`);
    }
  } catch {
    if (jsonMode) {
      console.log(JSON.stringify({ installed: { dir: repoName } }, null, 2));
    } else {
      console.log(`Installed: ${repoName} (manifest.json has errors but tile may still work)`);
    }
  }
}

async function remove(args) {
  const jsonMode = args.includes("--json");
  const name = args.find(a => a !== "--json");
  if (!name) {
    console.error("Usage: katulong extensions remove <name>");
    process.exit(1);
  }

  ensureExtensionsDir();
  const targetDir = join(EXTENSIONS_DIR, name);

  // Prevent path traversal
  if (name.includes("/") || name.includes("..") || name.startsWith(".")) {
    console.error("Invalid extension name.");
    process.exit(1);
  }

  if (!existsSync(targetDir)) {
    console.error(`Extension not found: ${name}`);
    console.error("Use 'katulong extensions list' to see installed extensions.");
    process.exit(1);
  }

  rmSync(targetDir, { recursive: true, force: true });

  if (jsonMode) {
    console.log(JSON.stringify({ removed: name }, null, 2));
  } else {
    console.log(`Removed: ${name}`);
    console.log("Restart Katulong to unload the extension.");
  }
}

const subcommands = { list, install, remove };

export default async function extensions(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    process.exit(sub ? 0 : 1);
  }

  if (!subcommands[sub]) {
    console.error(`Unknown subcommand: ${sub}`);
    usage();
    process.exit(1);
  }

  try {
    await subcommands[sub](args.slice(1));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
