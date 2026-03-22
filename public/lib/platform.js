/**
 * Platform Detection
 *
 * Single source of truth for device/platform identification.
 * Functions evaluate lazily (not at import time) so tests can
 * mock navigator before calling them.
 *
 * Returns "desktop", "ipad", or "phone".
 */

/** iPad detection — used by carousel and shortcut bar */
export function isIPad() {
  const ua = typeof navigator !== "undefined" ? (navigator.userAgent || "") : "";
  const tp = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0;
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && tp > 1);
}

/** @returns {"desktop" | "ipad" | "phone"} */
export function detectPlatform() {
  if (isIPad()) return "ipad";
  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) return "phone";
  return "desktop";
}
