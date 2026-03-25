/**
 * Settings Handlers
 *
 * Composable settings event handlers for theme, port proxy, and logout.
 */

import { api } from "/lib/api-client.js";

export function createSettingsHandlers(options = {}) {
  const {
    onThemeChange,
    onLogout,
    onPortProxyChange
  } = options;

  /**
   * Initialize theme toggle buttons
   */
  function initThemeToggle() {
    document.querySelectorAll(".theme-toggle button").forEach(btn => {
      btn.addEventListener("click", () => {
        const theme = btn.dataset.themeVal;
        if (onThemeChange) onThemeChange(theme);
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
    initThemeToggle();
    initLogout();
    initVersion();
  }

  return {
    init,
    initThemeToggle,
    initLogout
  };
}
