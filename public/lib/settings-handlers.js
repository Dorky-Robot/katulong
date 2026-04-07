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

  async function init() {
    let config = null;
    try {
      const data = await api.get("/api/config");
      config = data.config;
    } catch (error) {
      console.error("Failed to load config:", error);
    }
    initPortProxyToggle(config);
    initPalettePicker();
    initPolarityToggle();
    initVibrancyToggle();
    syncPaletteControls();
    initLogout();
    initVersion();
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
