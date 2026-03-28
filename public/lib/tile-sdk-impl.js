/**
 * Tile SDK Implementation
 *
 * Builds the `sdk` object that gets passed to tile setup() functions.
 * This is the real implementation of the APIs documented in docs/tile-sdk.md.
 *
 * Usage (by extension loader):
 *   const sdk = createTileSDK({ tileType, ws, api, ... });
 *   const tile = setupFn(sdk, options);
 *
 * The sdk is per-tile-type (not per-instance) since setup() is called
 * once per type registration. Instance-specific context (el, chrome)
 * comes via mount(container, ctx).
 */

import { api } from "/lib/api-client.js";

/**
 * Create the SDK object for a tile type.
 *
 * @param {object} deps — platform dependencies injected by app.js
 * @param {string} deps.tileType — the tile type name (for storage namespacing)
 * @param {function} deps.sendWs — send a WebSocket message
 * @param {function} deps.onWsMessage — subscribe to WS messages: (type, handler) → unsubscribe
 * @param {object} deps.platform — platform info
 * @returns {object} sdk
 */
export function createTileSDK(deps = {}) {
  const { tileType = "unknown", sendWs, onWsMessage, platform = {} } = deps;

  // ── sdk.storage — per-tile namespaced localStorage ──────────

  const storagePrefix = `katulong_tile_${tileType}_`;

  const storage = {
    get(key) {
      try {
        const raw = localStorage.getItem(storagePrefix + key);
        return raw !== null ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    },

    set(key, value) {
      try {
        localStorage.setItem(storagePrefix + key, JSON.stringify(value));
      } catch { /* quota exceeded */ }
    },

    remove(key) {
      localStorage.removeItem(storagePrefix + key);
    },

    keys() {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(storagePrefix)) {
          keys.push(k.slice(storagePrefix.length));
        }
      }
      return keys;
    },

    clear() {
      for (const key of storage.keys()) {
        storage.remove(key);
      }
    },
  };

  // ── sdk.sessions — terminal session management ──────────────

  const sessions = {
    async list() {
      return api.get("/sessions");
    },

    async create(name) {
      return api.post("/sessions", { name });
    },

    async kill(name) {
      return api.delete(`/sessions/${encodeURIComponent(name)}`);
    },

    async rename(oldName, newName) {
      return api.put(`/sessions/${encodeURIComponent(oldName)}/rename`, { name: newName });
    },
  };

  // ── sdk.terminal — headless terminal exec ───────────────────

  const terminal = {
    async exec(command) {
      // Create a temporary session, run the command, capture output, kill session
      const name = `_tile_exec_${Date.now().toString(36)}`;
      try {
        await sessions.create(name);
        // Send command via WebSocket
        if (sendWs) {
          sendWs({ type: "terminal:input", session: name, data: command + "\n" });
        }
        // Wait briefly for output
        await new Promise(r => setTimeout(r, 500));
        // Read output from session
        const data = await api.get(`/sessions/${encodeURIComponent(name)}/scrollback`);
        return data?.text || "";
      } finally {
        try { await sessions.kill(name); } catch {}
      }
    },

    send(session, data) {
      if (sendWs) sendWs({ type: "terminal:input", session, data });
    },
  };

  // ── sdk.pubsub — event system ───────────────────────────────

  const listeners = new Map();

  const pubsub = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },

    emit(event, data) {
      const handlers = listeners.get(event);
      if (handlers) handlers.forEach(fn => fn(data));
    },
  };

  // Wire up WebSocket messages to pubsub
  if (onWsMessage) {
    onWsMessage("*", (msg) => {
      pubsub.emit(msg.type, msg);
    });
  }

  // ── sdk.ws — raw WebSocket access ───────────────────────────

  const ws = {
    send(msg) { if (sendWs) sendWs(msg); },
    on(type, handler) {
      if (onWsMessage) return onWsMessage(type, handler);
      return () => {};
    },
  };

  // ── sdk.toast — notifications ───────────────────────────────

  function toast(message, opts = {}) {
    // Use katulong's toast system if available
    if (window.__katulong?.toast) {
      window.__katulong.toast(message, opts);
    } else {
      // Fallback: simple DOM toast
      const el = document.createElement("div");
      el.textContent = message;
      el.style.cssText = `
        position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
        background:#333; color:#fff; padding:8px 16px; border-radius:6px;
        font-size:13px; z-index:99999; opacity:0; transition:opacity 0.3s;
      `;
      document.body.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = "1"; });
      setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 300);
      }, opts.duration || 3000);
    }
  }

  // ── sdk.api — HTTP client ───────────────────────────────────

  const apiClient = {
    async get(path) { return api.get(path); },
    async post(path, body) { return api.post(path, body); },
    async put(path, body) { return api.put(path, body); },
    async delete(path) { return api.delete(path); },
  };

  // ── sdk.platform — platform info ────────────────────────────

  const platformInfo = {
    get isIPad() { return /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); },
    get isPhone() { return /iPhone|Android.*Mobile/.test(navigator.userAgent); },
    get isDesktop() { return !platformInfo.isIPad && !platformInfo.isPhone; },
    get isDark() { return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true; },
    get version() { return platform.version || "unknown"; },
    ...platform,
  };

  // ── Assemble SDK ────────────────────────────────────────────

  return {
    storage,
    sessions,
    terminal,
    pubsub,
    ws,
    toast,
    api: apiClient,
    platform: platformInfo,
  };
}
