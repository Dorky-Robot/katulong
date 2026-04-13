/**
 * WebSocket upgrade handler — authn, origin check, and route dispatch.
 *
 * Extracted from server.js because the upgrade flow is a discrete
 * protocol transition with its own invariants (auth, origin, then
 * dispatch to proxy / terminal) that benefits from reading
 * top-to-bottom in one file. server.js stays focused on route
 * assembly and HTTP lifecycle; this module owns "what happens when
 * a client tries to upgrade an HTTP connection to WebSocket".
 *
 * Security notes (do not weaken without review)
 * - `isAuthenticated()` is called first. A rejected upgrade never
 *   reaches handleUpgrade() of the WebSocketServer — no ws instance
 *   is ever created for an unauth request.
 * - Origin validation runs second. For trusted-proxy / localhost
 *   requests it is bypassed (localhost detection is already handled
 *   in isLocalRequest which looks at socket address + Host/Origin).
 *   For everything else, Origin header must match Host.
 * - After `wss.handleUpgrade()`, we re-validate the session token
 *   against fresh state — mitigates the window where a token was
 *   revoked mid-upgrade. If revoked, we close with 1008.
 * - Auth context (sessionToken, credentialId) is passed to
 *   wsManager.handleConnection as an explicit parameter. It is NOT
 *   stashed on the ws object — see lib/ws-manager.js for why.
 */

import { log } from "./log.js";
import { isLocalRequest } from "./access-method.js";

/**
 * Reject a pending upgrade by writing a bare HTTP status line and
 * destroying the socket. We never send a full HTML body here — the
 * client is expecting a 101 Switching Protocols response, so any
 * non-101 is effectively an error to them.
 */
function rejectUpgrade(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

/**
 * @param {object} opts
 * @param {import("ws").WebSocketServer} opts.wss
 * @param {(req: object) => ({ authenticated: boolean, sessionToken: string|null, credentialId: string|null }|null)} opts.isAuthenticated
 * @param {(req: object) => boolean} opts.isTrustedProxy
 * @param {() => object|null} opts.loadState - Returns fresh auth state (see lib/auth.js)
 * @param {{ getPortProxyEnabled: () => boolean|null }} opts.configManager
 * @param {(req: object, socket: object, head: Buffer, path: string) => void} opts.proxyWebSocket
 * @param {{ handleConnection: (ws: object, auth: object) => void }} opts.wsManager
 * @returns {(req: object, socket: object, head: Buffer) => void} - Handler for server.on("upgrade", …)
 */
export function createUpgradeHandler({
  wss,
  isAuthenticated,
  isTrustedProxy,
  loadState,
  configManager,
  proxyWebSocket,
  wsManager,
}) {
  function validateUpgradeOrigin(req) {
    if (isTrustedProxy(req)) return true;
    if (isLocalRequest(req)) return true;
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  return function handleUpgrade(req, socket, head) {
    log.info("WebSocket upgrade attempt", {
      ip: req.socket.remoteAddress,
      origin: req.headers.origin,
      host: req.headers.host,
    });

    const auth = isAuthenticated(req);
    if (!auth) {
      log.warn("WebSocket rejected: not authenticated", { ip: req.socket.remoteAddress });
      return rejectUpgrade(socket, "401 Unauthorized");
    }

    if (!validateUpgradeOrigin(req)) {
      log.warn("WebSocket rejected: origin validation failed", {
        origin: req.headers.origin,
        host: req.headers.host,
      });
      return rejectUpgrade(socket, "403 Forbidden");
    }

    const { pathname: wsPathname } = new URL(req.url, `http://${req.headers.host}`);

    // Port proxy WebSocket — intercept before terminal WS handling
    if (wsPathname.startsWith("/_proxy/")) {
      if (configManager.getPortProxyEnabled() === false) {
        return rejectUpgrade(socket, "403 Forbidden");
      }
      proxyWebSocket(req, socket, head, wsPathname);
      return;
    }

    const { sessionToken, credentialId } = auth;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sessionToken && !isLocalRequest(req)) {
        const freshState = loadState();
        if (!freshState || !freshState.isValidLoginToken(sessionToken)) {
          log.warn("WebSocket rejected during upgrade: session invalidated", {
            ip: req.socket.remoteAddress,
          });
          ws.close(1008, "Session invalidated");
          return;
        }
      }
      // Pass auth context explicitly instead of stashing it on the ws object.
      // ws-manager treats WebSocket as a transport, not an application-state
      // data carrier — see lib/ws-manager.js handleConnection() for the
      // rationale.
      wsManager.handleConnection(ws, { sessionToken, credentialId });
    });
  };
}
