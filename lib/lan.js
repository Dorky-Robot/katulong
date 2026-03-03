import os from "node:os";
import dgram from "node:dgram";

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

/**
 * Get the IPv4 address the OS would use for outgoing traffic (default route).
 *
 * Opens a UDP socket to 8.8.8.8 (no data sent) and checks which local
 * address the OS selected. This is the address whose interface the OS
 * routes through, so STUN responses will have the correct source IP.
 *
 * Returns null if detection fails (e.g. no network).
 *
 * @returns {Promise<string|null>}
 */
export function getDefaultAddress() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const cleanup = () => { try { sock.close(); } catch {} };
    sock.on("error", () => { cleanup(); resolve(null); });
    sock.connect(80, "8.8.8.8", () => {
      try {
        const { address } = sock.address();
        cleanup();
        resolve(address);
      } catch {
        cleanup();
        resolve(null);
      }
    });
  });
}
