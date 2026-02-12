/**
 * Wizard Utilities
 *
 * Utility functions for the pairing wizard.
 */

let connectInfoCache = null;
let qrLibLoaded = false;

/**
 * Load QR code library dynamically
 */
export async function loadQRLib() {
  if (qrLibLoaded) return;
  if (typeof QRCode !== "undefined") {
    qrLibLoaded = true;
    return;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/qrcode/qrcode.min.js";
    script.onload = () => {
      qrLibLoaded = true;
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/**
 * Get connection info (cached)
 */
export async function getConnectInfo() {
  if (connectInfoCache) return connectInfoCache;

  const res = await fetch("/connect/info");
  connectInfoCache = await res.json();
  return connectInfoCache;
}

/**
 * Check if pairing code has been consumed
 */
export async function checkPairingStatus(code) {
  try {
    const res = await fetch(`/auth/pair/status/${code}`);
    if (!res.ok) return false;

    const data = await res.json();
    return data.consumed;
  } catch (err) {
    return false;
  }
}
