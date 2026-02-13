/**
 * Settings Handlers
 *
 * Composable settings event handlers for theme and logout.
 */

import { addCsrfHeader } from "/lib/csrf.js";

/**
 * Create settings handlers
 */
export function createSettingsHandlers(options = {}) {
  const {
    onThemeChange,
    onLogout
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

    // Remote access - show logout button
    logoutBtn.addEventListener("click", async () => {
      await fetch("/auth/logout", {
        method: "POST",
        headers: addCsrfHeader()
      });

      if (onLogout) {
        onLogout();
      } else {
        location.href = "/login";
      }
    });
  }

  /**
   * Initialize all settings handlers
   */
  function init() {
    initThemeToggle();
    initLogout();
  }

  return {
    init,
    initThemeToggle,
    initLogout
  };
}
