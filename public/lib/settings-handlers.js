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
    onLogout,
    onInstanceNameChange
  } = options;

  /**
   * Initialize instance name input
   */
  async function initInstanceName() {
    const input = document.getElementById("instance-name-input");
    if (!input) return;

    try {
      // Load current instance name
      const response = await fetch("/api/config");
      const data = await response.json();

      if (data.config && data.config.instanceName) {
        input.value = data.config.instanceName;

        // Update document title
        document.title = `Katulong — ${data.config.instanceName}`;
      }
    } catch (error) {
      console.error("Failed to load instance name:", error);
    }

    // Save on blur
    input.addEventListener("blur", async () => {
      const instanceName = input.value.trim();
      if (!instanceName) {
        // Don't allow empty name
        input.value = input.dataset.previousValue || "Katulong";
        return;
      }

      try {
        const response = await fetch("/api/config/instance-name", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...addCsrfHeader()
          },
          body: JSON.stringify({ instanceName })
        });

        if (response.ok) {
          const data = await response.json();
          input.dataset.previousValue = data.instanceName;

          // Update document title
          document.title = `Katulong — ${data.instanceName}`;

          if (onInstanceNameChange) {
            onInstanceNameChange(data.instanceName);
          }
        } else {
          const error = await response.json();
          alert(`Failed to update instance name: ${error.error}`);
          input.value = input.dataset.previousValue || "Katulong";
        }
      } catch (error) {
        console.error("Failed to save instance name:", error);
        alert("Failed to save instance name");
        input.value = input.dataset.previousValue || "Katulong";
      }
    });

    // Store current value on focus
    input.addEventListener("focus", () => {
      input.dataset.previousValue = input.value;
    });
  }

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
    initInstanceName();
    initThemeToggle();
    initLogout();
  }

  return {
    init,
    initInstanceName,
    initThemeToggle,
    initLogout
  };
}
