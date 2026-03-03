import os from "node:os";

/**
 * Get non-internal IPv4 LAN addresses from all network interfaces.
 *
 * @returns {string[]} List of IPv4 addresses (e.g. ["192.168.1.138", "192.168.1.181"])
 */
export function getLanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}
