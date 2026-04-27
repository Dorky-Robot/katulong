/**
 * Settings Handlers
 *
 * Composable settings event handlers for the palette controls, port proxy,
 * and logout.
 *
 * The palette picker has four parts:
 *   1. An `<input type="color">` hidden inside a .palette-swatch label —
 *      native color chrome is suppressed so the swatch itself shows the
 *      current tint; clicking opens the OS color picker.
 *   2. A hex text input — hand-typing a color (e.g., paste a brand hex).
 *   3. A polarity radio group (auto/light/dark).
 *   4. A vibrancy radio group (subtle/colorful) — picks how much of the
 *      tint hue saturates the surfaces and text.
 *
 * The running app is the live preview — no separate swatch grid.
 */

import { api } from "/lib/api-client.js";

export function createSettingsHandlers(options = {}) {
  const {
    onAnchorChange,
    onPolarityChange,
    onVibrancyChange,
    getPreferences,      // () => { anchor, polarity, vibrancy }
                         //   User-selected values straight from theme-manager.
                         //   polarity may be "auto" here — that's how we know to
                         //   highlight the Auto button. The resolved palette polarity
                         //   ("dark"|"light") would never match "auto" and would leave
                         //   the Auto button permanently unselectable.
    onLogout,
    onPortProxyChange
  } = options;

  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  /** Sync all palette controls to the current palette state. */
  function syncPaletteControls() {
    if (!getPreferences) return;
    const prefs = getPreferences();
    if (!prefs) return;

    // Swatch + color input + hex input
    const colorInput = document.getElementById("palette-anchor-input");
    const hexInput = document.getElementById("palette-anchor-hex");
    const swatch = document.querySelector(".palette-swatch");
    if (colorInput) colorInput.value = prefs.anchor;
    if (hexInput) {
      hexInput.value = prefs.anchor;
      hexInput.classList.remove("invalid");
    }
    if (swatch) swatch.style.background = prefs.anchor;

    // Polarity radio buttons — match against the user *preference* (auto/dark/light),
    // not the resolved palette polarity. Otherwise picking "Auto" would highlight
    // whichever concrete polarity it resolved to (Dark on a dark-mode OS), making
    // the Auto button appear permanently unselectable.
    document.querySelectorAll("[data-polarity-val]").forEach(btn => {
      const active = btn.dataset.polarityVal === prefs.polarity;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    });

    // Vibrancy radio buttons (subtle / colorful)
    document.querySelectorAll("[data-vibrancy-val]").forEach(btn => {
      const active = btn.dataset.vibrancyVal === prefs.vibrancy;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  }

  /** Initialize anchor color picker (color input + hex text input). */
  function initPalettePicker() {
    const colorInput = document.getElementById("palette-anchor-input");
    const hexInput = document.getElementById("palette-anchor-hex");

    if (colorInput) {
      // Live update as the user drags the native picker
      colorInput.addEventListener("input", () => {
        const hex = colorInput.value;
        if (HEX_RE.test(hex) && onAnchorChange) {
          onAnchorChange(hex);
          syncPaletteControls();
        }
      });
    }

    if (hexInput) {
      const commit = () => {
        const hex = hexInput.value.trim().toLowerCase();
        const normalized = hex.startsWith("#") ? hex : `#${hex}`;
        if (HEX_RE.test(normalized)) {
          hexInput.classList.remove("invalid");
          if (onAnchorChange) onAnchorChange(normalized);
          syncPaletteControls();
        } else {
          hexInput.classList.add("invalid");
        }
      };
      hexInput.addEventListener("change", commit);
      hexInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
      });
      // Clear invalid state as soon as the user starts typing a fresh value
      hexInput.addEventListener("input", () => {
        hexInput.classList.remove("invalid");
      });
    }
  }

  /** Initialize polarity toggle buttons. */
  function initPolarityToggle() {
    document.querySelectorAll("[data-polarity-val]").forEach(btn => {
      btn.addEventListener("click", () => {
        const polarity = btn.dataset.polarityVal;
        if (onPolarityChange) onPolarityChange(polarity);
        syncPaletteControls();
      });
    });
  }

  /** Initialize vibrancy toggle buttons (subtle / colorful). */
  function initVibrancyToggle() {
    document.querySelectorAll("[data-vibrancy-val]").forEach(btn => {
      btn.addEventListener("click", () => {
        const vibrancy = btn.dataset.vibrancyVal;
        if (onVibrancyChange) onVibrancyChange(vibrancy);
        syncPaletteControls();
      });
    });
  }

  /**
   * Initialize port proxy toggle
   */
  function initPortProxyToggle(config) {
    const toggle = document.getElementById("port-proxy-toggle");
    if (!toggle) return;

    const enabled = config ? config.portProxyEnabled !== false : true;
    toggle.checked = enabled;

    if (onPortProxyChange) onPortProxyChange(enabled);

    toggle.addEventListener("change", async () => {
      try {
        await api.put("/api/config/port-proxy-enabled", { portProxyEnabled: toggle.checked });
        if (onPortProxyChange) onPortProxyChange(toggle.checked);
      } catch (error) {
        console.error("Failed to save port proxy setting:", error);
        toggle.checked = !toggle.checked;
      }
    });
  }

  /**
   * Initialize logout button
   */
  function initLogout() {
    const logoutBtn = document.getElementById("settings-logout");
    if (!logoutBtn) return;

    // Hide logout button on localhost - localhost is root/admin access
    const isLocalhost = location.hostname === 'localhost' ||
                       location.hostname === '127.0.0.1' ||
                       location.hostname === '::1';

    if (isLocalhost) {
      logoutBtn.style.display = 'none';
      return;
    }

    logoutBtn.addEventListener("click", async () => {
      try {
        await api.post("/auth/logout");
      } catch {
        // Cookie may have been cleared even if the request failed — redirect anyway
      }

      if (onLogout) {
        onLogout();
      } else {
        location.href = "/login";
      }
    });
  }

  function initVersion() {
    const el = document.getElementById("settings-version");
    const version = document.body.dataset.version;
    if (el && version) {
      el.textContent = `v${version}`;
    }
  }

  /** Initialize public URL input. */
  function initPublicUrl(config) {
    const input = document.getElementById("public-url-input");
    if (!input) return;

    // Show current origin as placeholder so the user sees what's auto-detected
    const isLocalhost = location.hostname === "localhost" ||
                        location.hostname === "127.0.0.1" ||
                        location.hostname === "::1";
    if (!isLocalhost) {
      input.placeholder = location.origin;
    }
    input.value = config?.publicUrl || "";

    const save = async () => {
      const val = input.value.trim();
      try {
        await api.put("/api/config/public-url", { publicUrl: val });
        input.classList.remove("invalid");
      } catch {
        input.classList.add("invalid");
      }
    };

    input.addEventListener("change", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
    });
    input.addEventListener("input", () => input.classList.remove("invalid"));
  }

  /** Initialize the External LLM endpoint section.
   *
   *  GET /api/config/ollama-peer returns {url, hasToken}; the token is
   *  never sent back to the client. The input shows blank with a
   *  "(token already set)" hint when a token exists server-side; typing
   *  a new value overrides; Clear sets both to null.
   */
  function initOllamaPeer() {
    const urlInput   = document.getElementById("ollama-peer-url-input");
    const tokenInput = document.getElementById("ollama-peer-token-input");
    const tokenState = document.getElementById("ollama-peer-token-state");
    const saveBtn    = document.getElementById("ollama-peer-save-btn");
    const testBtn    = document.getElementById("ollama-peer-test-btn");
    const clearBtn   = document.getElementById("ollama-peer-clear-btn");
    const statusEl   = document.getElementById("ollama-peer-status");
    if (!urlInput || !tokenInput) return;

    const setStatus = (msg, kind = "neutral") => {
      statusEl.textContent = msg;
      statusEl.style.color = kind === "ok"  ? "var(--accent)"
                          : kind === "err" ? "var(--danger, #d33)"
                          : "var(--text-muted)";
    };

    async function load() {
      try {
        const data = await api.get("/api/config/ollama-peer");
        urlInput.value = data.url || "";
        tokenInput.value = "";
        tokenState.textContent = data.hasToken
          ? "token already set — leave blank to keep, or type to replace"
          : "no token set";
      } catch (err) {
        setStatus(`load failed: ${err.message}`, "err");
      }
    }

    async function save() {
      const url = urlInput.value.trim();
      const tokenTyped = tokenInput.value;
      const body = { url: url || null };
      // Only include token when the user typed something, so an empty
      // box doesn't accidentally clear a previously-saved token.
      if (tokenTyped.length > 0) body.token = tokenTyped;
      try {
        setStatus("saving...");
        await api.put("/api/config/ollama-peer", body);
        setStatus("saved", "ok");
        await load();
      } catch (err) {
        setStatus(`save failed: ${err.message}`, "err");
      }
    }

    async function test() {
      setStatus("testing...");
      try {
        const result = await api.post("/api/config/ollama-peer/test", {});
        if (result.ok) {
          const count = result.models?.length ?? 0;
          setStatus(
            count > 0
              ? `✓ reachable (${count} model${count === 1 ? "" : "s"} available)`
              : "✓ reachable, but no models loaded on the bridge",
            "ok",
          );
        } else {
          setStatus(`✗ ${result.error || "unknown error"}`, "err");
        }
      } catch (err) {
        setStatus(`✗ ${err.message}`, "err");
      }
    }

    async function clear() {
      try {
        await api.put("/api/config/ollama-peer", { url: null, token: null });
        setStatus("cleared — using local Ollama", "neutral");
        await load();
      } catch (err) {
        setStatus(`clear failed: ${err.message}`, "err");
      }
    }

    saveBtn?.addEventListener("click", save);
    testBtn?.addEventListener("click", test);
    clearBtn?.addEventListener("click", clear);
    load();
  }

  /** Initialize Claude Code hooks copy button. */
  function initClaudeHooksSnippet() {
    const copyBtn = document.getElementById("claude-hooks-copy");
    if (!copyBtn) return;

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("katulong setup claude-hooks");
        copyBtn.classList.add("copied");
        copyBtn.querySelector("i").className = "ph ph-check";
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.querySelector("i").className = "ph ph-copy";
        }, 2000);
      } catch { /* clipboard may be unavailable */ }
    });
  }

  async function init() {
    let config = null;
    try {
      const data = await api.get("/api/config");
      config = data.config;
    } catch (error) {
      console.error("Failed to load config:", error);
    }
    initPublicUrl(config);
    initPortProxyToggle(config);
    initPalettePicker();
    initPolarityToggle();
    initVibrancyToggle();
    syncPaletteControls();
    initLogout();
    initVersion();
    initClaudeHooksSnippet();
    initOllamaPeer();
  }

  return {
    init,
    initPalettePicker,
    initPolarityToggle,
    initVibrancyToggle,
    syncPaletteControls,
    initLogout,
  };
}
