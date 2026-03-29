/**
 * Tile SDK Implementation
 *
 * Constructs the `sdk` object passed to extension tile setup() functions.
 * Each tile type gets its own SDK instance with namespaced storage.
 *
 * Usage (by extension loader):
 *   import { createTileSDK } from "/lib/tile-sdk-impl.js";
 *   const sdk = createTileSDK("plano", appDeps);
 *   const factory = (opts) => setupFn(sdk, opts);
 */

/**
 * @param {string} tileType — tile type name (for storage namespace)
 * @param {object} deps — app-level dependencies
 * @param {function} deps.getWs — returns current WebSocket (or null)
 * @param {object} deps.api — the api-client module { get, post, put, del }
 * @param {function} deps.toast — showToast function
 * @param {object} deps.platform — { version }
 */
export function createTileSDK(tileType, deps = {}) {
  const { getWs, api, toast: toastFn, platform: platformInfo = {} } = deps;

  // ── sdk.storage ────────────────────────────────────────────
  const prefix = `katulong-tile-${tileType}:`;

  const storage = {
    get(key) {
      try {
        const raw = localStorage.getItem(prefix + key);
        return raw !== null ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch {}
    },
    remove(key) { localStorage.removeItem(prefix + key); },
    keys() {
      const result = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(prefix)) result.push(k.slice(prefix.length));
      }
      return result;
    },
    clear() { storage.keys().forEach(k => storage.remove(k)); },
  };

  // ── sdk.platform ───────────────────────────────────────────
  const platform = {
    get isIPad() { return /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); },
    get isPhone() { return /iPhone|Android.*Mobile/.test(navigator.userAgent); },
    get isDesktop() { return !platform.isIPad && !platform.isPhone; },
    get isDark() { return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true; },
    get version() { return platformInfo.version || "unknown"; },
  };

  // ── sdk.api ────────────────────────────────────────────────
  const apiClient = api || {
    async get(path) { const r = await fetch(path); return r.ok ? r.json() : null; },
    async post(path, body) { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.ok ? r.json() : null; },
    async put(path, body) { const r = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.ok ? r.json() : null; },
    async del(path) { const r = await fetch(path, { method: "DELETE" }); return r.ok ? r.json() : null; },
  };

  // ── sdk.toast ──────────────────────────────────────────────
  function toast(msg, opts = {}) {
    if (toastFn) { toastFn(msg, opts.isError || false); return; }
    // Fallback
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;z-index:99999;opacity:0;transition:opacity 0.3s;";
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "1"; });
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, opts.duration || 3000);
  }

  // ── sdk.ws ─────────────────────────────────────────────────
  const ws = {
    send(msg) {
      const socket = getWs?.();
      if (socket?.readyState === 1) socket.send(JSON.stringify(msg));
    },
    on(type, handler) {
      // TODO: wire to WebSocket message router when available
      return () => {};
    },
  };

  // ── sdk.pubsub ─────────────────────────────────────────────
  const _listeners = new Map();
  const pubsub = {
    on(event, handler) {
      if (!_listeners.has(event)) _listeners.set(event, new Set());
      _listeners.get(event).add(handler);
      return () => _listeners.get(event)?.delete(handler);
    },
    emit(event, data) {
      _listeners.get(event)?.forEach(fn => fn(data));
    },
  };

  // ── sdk.sessions ───────────────────────────────────────────
  const sessions = {
    async list() { return apiClient.get("/sessions"); },
    async create(name) { return apiClient.post("/sessions", { name }); },
    async kill(name) { return apiClient.del(`/sessions/${encodeURIComponent(name)}`); },
  };

  // ── Assemble ───────────────────────────────────────────────
  return Object.freeze({ storage, platform, api: apiClient, toast, ws, pubsub, sessions });
}
