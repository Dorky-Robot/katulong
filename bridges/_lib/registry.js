/**
 * Bridge registry — discovers each `bridges/<name>/manifest.js` at runtime.
 *
 * A bridge is registered simply by having a directory under `bridges/`
 * (the dir name is the bridge name) that exports a default object from
 * `manifest.js`:
 *
 *     export default {
 *       name: "ollama",          // must match the directory name
 *       port: 11435,             // default port (operators can override)
 *       target: "http://127.0.0.1:11434",
 *       description: "Authenticated reverse proxy to local Ollama",
 *       bind: "127.0.0.1",       // optional; default 127.0.0.1
 *     };
 *
 * Directories whose names start with "_" (e.g., `_lib`) are skipped.
 *
 * The discovery is intentionally synchronous on first call and cached
 * afterwards — bridges are statically defined at the source level, so
 * caching the manifest list for the life of the process is fine.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGES_ROOT = join(HERE, "..");

let cache = null;

function isBridgeDir(name) {
  if (name.startsWith(".") || name.startsWith("_")) return false;
  const fullPath = join(BRIDGES_ROOT, name);
  if (!statSync(fullPath, { throwIfNoEntry: false })?.isDirectory()) return false;
  return existsSync(join(fullPath, "manifest.js"));
}

async function loadManifest(name) {
  const url = `../${name}/manifest.js`;
  const mod = await import(url);
  if (!mod.default || mod.default.name !== name) {
    throw new Error(
      `bridges/${name}/manifest.js must export a default object with name === "${name}"`,
    );
  }
  return mod.default;
}

export async function listBridges() {
  if (cache) return cache;
  const dirs = readdirSync(BRIDGES_ROOT).filter(isBridgeDir);
  const manifests = await Promise.all(dirs.map(loadManifest));
  cache = manifests.sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

export async function getBridge(name) {
  const all = await listBridges();
  const found = all.find((b) => b.name === name);
  if (!found) {
    const known = all.map((b) => b.name).join(", ") || "(none)";
    throw new Error(`unknown bridge "${name}". Known: ${known}`);
  }
  return found;
}

/** Test-only: drop the cached registry so a different fixture can be loaded. */
export function resetRegistryCache() {
  cache = null;
}
