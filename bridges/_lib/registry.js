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

// Bridge names flow into filesystem paths (`<dataDir>/bridges/<name>/`),
// launchd labels (`com.dorkyrobot.katulong-bridge.<name>`), and shell
// invocations (launchctl load on the resulting plist path). We require
// a strict allowlist so a hostile or malformed directory name cannot
// path-traverse, inject XML, or escape shell quoting downstream.
const BRIDGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Reserved because `katulong bridge list` is dispatched at the top level
// — a bridge named "list" would shadow that and become unreachable via
// the per-bridge action surface.
const RESERVED_NAMES = new Set(["list"]);

export function isValidBridgeName(name) {
  return typeof name === "string" && BRIDGE_NAME_RE.test(name) && !RESERVED_NAMES.has(name);
}

let cache = null;

function isBridgeDir(name) {
  if (!isValidBridgeName(name)) return false;
  const fullPath = join(BRIDGES_ROOT, name);
  if (!statSync(fullPath, { throwIfNoEntry: false })?.isDirectory()) return false;
  return existsSync(join(fullPath, "manifest.js"));
}

async function loadManifest(name) {
  const url = `../${name}/manifest.js`;
  let mod;
  try {
    mod = await import(url);
  } catch (err) {
    throw new Error(`bridges/${name}/manifest.js failed to load: ${err.message}`);
  }
  if (!mod.default || mod.default.name !== name) {
    throw new Error(
      `bridges/${name}/manifest.js must export a default object with name === "${name}"`,
    );
  }
  return mod.default;
}

export async function listBridges() {
  // Coalesce concurrent callers onto the same in-flight Promise instead of
  // letting each one launch its own `Promise.all`. Important if listBridges()
  // is ever called from two paths before the first resolves.
  if (cache) return cache;
  cache = (async () => {
    const dirs = readdirSync(BRIDGES_ROOT).filter(isBridgeDir);
    const manifests = await Promise.all(dirs.map(loadManifest));
    return manifests.sort((a, b) => a.name.localeCompare(b.name));
  })();
  try {
    return await cache;
  } catch (err) {
    cache = null; // don't pin a failed import
    throw err;
  }
}

export async function getBridge(name) {
  if (!isValidBridgeName(name)) {
    throw new Error(
      `invalid bridge name "${name}" — must be lowercase alphanumeric ` +
        `(plus hyphens), start with [a-z0-9], at most 64 chars, ` +
        `and not collide with reserved names (list)`,
    );
  }
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
