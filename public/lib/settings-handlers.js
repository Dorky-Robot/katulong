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
    if (logoutBtn) {
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
