/**
 * Detect the reverse proxy base path from the current URL.
 *
 * When katulong is served through a reverse proxy (e.g., abot at
 * /katulong/{kubo}/), the base path is everything before the first
 * katulong route segment. Direct access returns "".
 *
 * Examples:
 *   /                        → ""
 *   /?s=my-session           → ""
 *   /katulong/my-kubo        → "/katulong/my-kubo"
 *   /katulong/my-kubo/       → "/katulong/my-kubo"
 *   /katulong/my-kubo/login  → "/katulong/my-kubo"
 */

// Katulong's own routes — used to strip the suffix and find the proxy prefix.
const KNOWN_ROUTES = ["/login", "/login.html", "/stream", "/health"];

function detectBasePath() {
  const path = location.pathname;

  // Direct access — no prefix
  if (path === "/" || path === "") return "";

  // Strip known route suffixes to find the prefix
  for (const route of KNOWN_ROUTES) {
    if (path.endsWith(route)) {
      return path.slice(0, -route.length);
    }
  }

  // If the path has segments and doesn't match a known route,
  // it's likely the proxy prefix itself (e.g., /katulong/my-kubo)
  // Strip trailing slash
  return path.replace(/\/$/, "");
}

/** The detected base path, empty string for direct access. */
export const basePath = detectBasePath();
