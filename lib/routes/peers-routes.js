/**
 * Peer-katulong routes — cross-instance tile spike.
 *
 * Three concerns, three routes:
 *   GET  /api/peers                — list peers (no api keys leak out)
 *   GET  /api/peers/:id/sessions   — proxy peer's session list using stored key
 *   GET  /api/peers/:id/credentials — return {peerUrl, apiKey, label} so the
 *                                     tile can build a WS URL with ?api_key=
 *   PUT  /api/config/peers         — replace peers config (validated)
 *
 * Why a server-side proxy rather than letting the browser hit the peer
 * directly: the browser doesn't have the api key until it asks for it
 * (the `/credentials` route). The session-list call needs to work
 * BEFORE the user picks a session — at which point the picker has no
 * key. Proxying through this server keeps the picker simple, keeps the
 * key server-side until tile spawn, and gives us one logical place to
 * add caching / failure handling later.
 *
 * Threat model
 *   The api key is a cross-instance authn credential — possession ⇒
 *   full session access on the peer. Anyone with a valid katulong
 *   session here can already act as the user, so exposing api keys to
 *   such a session via /credentials is not a privilege escalation.
 *   What we DO guard against:
 *     - unauthenticated callers reaching peer keys (auth() middleware)
 *     - SSRF: only call peer URLs that are explicitly configured
 *     - log spillage: never log apiKey or response bodies
 *     - probing: id pattern is restricted to [a-zA-Z0-9._-]
 */

import { log } from "../log.js";

// Bound the proxied call so a slow / dead peer doesn't tie up a request
// slot indefinitely. 8s matches the heartbeat timeout in
// connection-manager.js — beyond that we assume the peer is gone.
const PEER_FETCH_TIMEOUT_MS = 8_000;

const PEER_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function createPeersRoutes({
  json,
  parseJSON,
  configManager,
  auth,
  csrf,
  fetchFn = globalThis.fetch,
}) {
  if (!configManager) throw new Error("createPeersRoutes: configManager required");
  if (typeof fetchFn !== "function") {
    throw new Error("createPeersRoutes: fetchFn required (use globalThis.fetch in prod)");
  }

  // GET /api/peers — public-shape listing, key never appears.
  function handleListPeers(req, res) {
    const peers = configManager.getPeers();
    json(res, 200, { peers });
  }

  // GET /api/peers/:id/sessions — proxy to the peer's session list.
  async function handlePeerSessions(req, res, id) {
    if (!PEER_ID_RE.test(id)) {
      return json(res, 400, { error: "Invalid peer id" });
    }
    const peer = configManager.getPeerById(id);
    if (!peer) {
      return json(res, 404, { error: "Peer not configured" });
    }
    const target = `${peer.url.replace(/\/+$/, "")}/sessions`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PEER_FETCH_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchFn(target, {
        method: "GET",
        headers: { Authorization: `Bearer ${peer.apiKey}` },
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Don't echo `err.message` to the client — for `fetch` errors
      // it can include the URL we just constructed (and we don't want
      // a junk peer.url leaking to a misled caller).
      log.warn("Peer session-list proxy failed", { peerId: id, error: err?.code || err?.name || "fetch-error" });
      return json(res, 502, { error: "Peer unreachable" });
    }
    clearTimeout(timer);
    if (!upstream.ok) {
      log.warn("Peer session-list returned non-2xx", { peerId: id, status: upstream.status });
      return json(res, 502, { error: `Peer returned ${upstream.status}` });
    }
    let body;
    try { body = await upstream.json(); }
    catch { return json(res, 502, { error: "Peer returned invalid JSON" }); }
    // The peer responds in `{sessions: [...]}` shape (see /sessions GET in
    // app-routes.js). Accept both that shape and a bare array, and only
    // forward the fields we actually use — defense against a future peer
    // that adds a sensitive field we'd otherwise reflect verbatim.
    const raw = Array.isArray(body) ? body : Array.isArray(body?.sessions) ? body.sessions : [];
    const filtered = raw.map((s) => ({
      name: s?.name ?? null,
      alive: !!s?.alive,
      title: s?.userTitle || s?.autoTitle || s?.meta?.claude?.summary || null,
    })).filter((s) => typeof s.name === "string" && s.name.length > 0);
    json(res, 200, { sessions: filtered });
  }

  // GET /api/peers/:id/credentials — return {peerUrl, apiKey, label} so the
  // tile renderer can build a `wss://peer/?api_key=…` URL. Auth-gated
  // (caller must already be authenticated to this katulong).
  function handlePeerCredentials(req, res, id) {
    if (!PEER_ID_RE.test(id)) {
      return json(res, 400, { error: "Invalid peer id" });
    }
    const peer = configManager.getPeerById(id);
    if (!peer) return json(res, 404, { error: "Peer not configured" });
    json(res, 200, {
      id: peer.id,
      peerUrl: peer.url,
      apiKey: peer.apiKey,
      label: peer.label || peer.id,
    });
  }

  // PUT /api/config/peers — replace the configured peers.
  async function handleSetPeers(req, res) {
    const body = await parseJSON(req);
    if (!body || typeof body !== "object") {
      return json(res, 400, { error: "Body must be a JSON object" });
    }
    if (body.peers !== null && !Array.isArray(body.peers)) {
      return json(res, 400, { error: "peers must be an array or null" });
    }
    try {
      await configManager.setPeers(body.peers);
    } catch (err) {
      return json(res, 400, { error: err.message || "Invalid peers payload" });
    }
    json(res, 200, { peers: configManager.getPeers() });
  }

  return [
    { method: "GET",  path:   "/api/peers",          handler: auth(handleListPeers) },
    { method: "GET",  prefix: "/api/peers/",         handler: auth(async (req, res, param) => {
      // param is everything after /api/peers/, e.g. "mini/sessions" or "mini/credentials"
      const slash = param.indexOf("/");
      if (slash < 1) return json(res, 404, { error: "Not found" });
      const id = param.slice(0, slash);
      const tail = param.slice(slash + 1);
      if (tail === "sessions") return handlePeerSessions(req, res, id);
      if (tail === "credentials") return handlePeerCredentials(req, res, id);
      return json(res, 404, { error: "Not found" });
    })},
    { method: "PUT",  path:   "/api/config/peers",   handler: auth(csrf(handleSetPeers)) },
  ];
}
