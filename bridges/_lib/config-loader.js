/**
 * Per-bridge config storage. Each bridge gets its own dir under
 * `<DATA_DIR>/bridges/<bridge-name>/config.json` so adding/removing
 * bridges doesn't churn a single shared file.
 *
 * The shape is intentionally tiny — bridges run from their manifest's
 * defaults; the config file just holds the operator-supplied secret
 * (`token`) plus optional per-host overrides (`port`, `bind`, `target`).
 *
 * mode 0600 + atomic temp+rename matches the rest of katulong's secrets
 * (lib/auth-state.js, lib/config.js).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

export function bridgeConfigPath(dataDir, bridgeName) {
  return join(dataDir, "bridges", bridgeName, "config.json");
}

/**
 * Load a bridge's config. Returns null if no config file exists yet.
 * Throws on malformed JSON — the operator should know if their config
 * is corrupted rather than silently using defaults.
 */
export function loadBridgeConfig(dataDir, bridgeName) {
  const path = bridgeConfigPath(dataDir, bridgeName);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`bridge config at ${path} is malformed: ${err.message}`);
  }
}

/**
 * Resolve the effective port/bind/target/token for a bridge by overlaying
 * config (if any) on top of the manifest defaults. Throws if no token is
 * configured — the bridge can't safely run without one.
 */
export function resolveBridge({ manifest, dataDir }) {
  const config = loadBridgeConfig(dataDir, manifest.name) || {};
  const port = Number(config.port ?? manifest.port);
  const bind = config.bind ?? manifest.bind ?? "127.0.0.1";
  const target = config.target ?? manifest.target;
  const token = config.token ?? null;

  if (!token) {
    throw new Error(
      `bridge "${manifest.name}" has no token configured. ` +
        `Run: katulong bridge ${manifest.name} new-token`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bridge "${manifest.name}" has invalid port ${port}`);
  }
  if (typeof target !== "string" || !/^https?:\/\//.test(target)) {
    throw new Error(
      `bridge "${manifest.name}" target must start with http:// or https://`,
    );
  }
  return { port, bind, target, token };
}

export function writeBridgeConfig(dataDir, bridgeName, partial) {
  const path = bridgeConfigPath(dataDir, bridgeName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existing = loadBridgeConfig(dataDir, bridgeName) || {};
  const merged = { ...existing, ...partial };
  // Drop nulls so the file stays minimal.
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmpPath, path);
  // Belt-and-suspenders: enforce 0600 even if umask interfered. Only
  // swallow "filesystem doesn't support chmod" — surface ENOENT/EPERM
  // because either of those means the file is in a worse state than
  // we expect (gone or unwritable) and the operator should know.
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    if (err.code !== "ENOTSUP" && err.code !== "ENOSYS") throw err;
  }
}

export function generateToken() {
  return randomBytes(32).toString("hex"); // 64 hex chars = 256 bits
}
