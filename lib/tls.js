import { networkInterfaces } from "node:os";
import { log } from "./log.js";

// DEPRECATED: LAN TLS support is deprecated and will be removed in a future
// release. Use a tunnel service (cloudflared, ngrok, Cloudflare Tunnel, etc.)
// for remote access instead. The tunnel handles TLS termination externally so
// no local certificate management is required.
let _warned = false;
function warnDeprecated() {
  if (!_warned) {
    _warned = true;
    log.warn(
      "DEPRECATED: LAN TLS certificate support is deprecated and will be removed. " +
      "Use a tunnel service (cloudflared, ngrok, Cloudflare Tunnel) for remote access — " +
      "the tunnel handles TLS termination and no local certificate management is needed.",
    );
  }
}

export function getLanIPs() {
  warnDeprecated();
  const ips = [];
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.family === "IPv4") ips.push(iface.address);
    }
  }
  return ips;
}

export function generateCA(_instanceName, _instanceId) {
  warnDeprecated();
  throw new Error("LAN TLS support has been removed. Use a tunnel service instead.");
}

export function inspectCert(_dataDir) {
  warnDeprecated();
  return { exists: false };
}

export function needsRegeneration(_dataDir) {
  warnDeprecated();
  return {
    needed: false,
    reason: "LAN TLS support has been removed",
    currentIps: getLanIPs(),
    certIps: [],
    missingIps: [],
  };
}

export function regenerateServerCert(_dataDir, _instanceName) {
  warnDeprecated();
  throw new Error("LAN TLS support has been removed. Use a tunnel service instead.");
}

export function generateMobileConfig(_caCertPem, _instanceName, _instanceId) {
  warnDeprecated();
  throw new Error("LAN TLS support has been removed. Use a tunnel service instead.");
}

export function ensureCerts(_dataDir, _instanceName, _instanceId, _options) {
  warnDeprecated();
  throw new Error("LAN TLS support has been removed. Use a tunnel service instead.");
}
