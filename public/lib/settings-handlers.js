/**
 * Settings Handlers
 *
 * Composable settings event handlers for theme and logout.
 */

import { addCsrfHeader } from "/lib/csrf.js";

/**
 * Phosphor Icons organized by category
 */
const ICON_CATEGORIES = {
  "Computers & Devices": [
    "terminal-window", "laptop", "desktop-tower", "device-mobile", "monitor", "computer-tower",
    "hard-drives", "cpu", "database", "floppy-disk", "bluetooth", "usb", "printer",
    "keyboard", "mouse", "headphones", "microphone", "webcam", "hard-drive",
    "memory", "sim-card", "wifi-high", "network-slash", "broadcast", "code",
    "bug", "git-branch", "github-logo", "terminal", "browser", "stack"
  ],
  "Locations": [
    "house", "buildings", "globe", "map-pin", "compass", "signpost", "airplane",
    "train", "car", "bicycle", "office-chair", "bank", "hospital", "school",
    "church", "factory", "warehouse", "tree", "mountains", "island",
    "bridge", "lighthouse", "tent", "castle", "city"
  ],
  "Objects & Symbols": [
    "cube", "package", "briefcase", "backpack", "coffee", "hamburger", "pizza",
    "lightbulb", "star", "heart", "rocket", "trophy", "flag", "fire", "cloud",
    "sun", "moon", "lightning", "snowflake", "umbrella", "music-note", "film-strip",
    "camera", "palette", "paint-brush", "pencil", "book", "notebook",
    "game-controller", "basketball", "soccer-ball", "baseball", "football",
    "anchor", "gear", "wrench", "hammer", "shield", "lock", "key"
  ]
};

/**
 * Create settings handlers
 */
/**
 * Toolbar color options (Catppuccin-inspired)
 */
const TOOLBAR_COLORS = [
  { id: "default", name: "Default", color: "#313244" },
  { id: "blue", name: "Blue", color: "#89b4fa" },
  { id: "purple", name: "Purple", color: "#cba6f7" },
  { id: "green", name: "Green", color: "#a6e3a1" },
  { id: "red", name: "Red", color: "#f38ba8" },
  { id: "orange", name: "Orange", color: "#fab387" },
  { id: "pink", name: "Pink", color: "#f5c2e7" },
  { id: "teal", name: "Teal", color: "#94e2d5" },
  { id: "yellow", name: "Yellow", color: "#f9e2af" }
];

export function createSettingsHandlers(options = {}) {
  const {
    onThemeChange,
    onLogout,
    onInstanceNameChange,
    onInstanceIconChange,
    onToolbarColorChange
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

      // Also load instance icon if callback provided
      if (data.config && data.config.instanceIcon && onInstanceIconChange) {
        onInstanceIconChange(data.config.instanceIcon);
      }

      // Also load toolbar color if callback provided
      if (data.config && data.config.toolbarColor && onToolbarColorChange) {
        onToolbarColorChange(data.config.toolbarColor);
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
   * Initialize instance icon picker
   */
  async function initInstanceIcon() {
    const iconBtn = document.getElementById("instance-icon-btn");
    const iconDisplay = document.getElementById("instance-icon-display");
    const overlay = document.getElementById("icon-picker-overlay");
    const closeBtn = document.getElementById("icon-picker-close");

    if (!iconBtn || !iconDisplay || !overlay || !closeBtn) return;

    let currentIcon = "terminal-window";

    // Load current instance icon
    try {
      const response = await fetch("/api/config");
      const data = await response.json();

      if (data.config && data.config.instanceIcon) {
        currentIcon = data.config.instanceIcon;
        iconDisplay.className = `ph ph-${currentIcon}`;
      }
    } catch (error) {
      console.error("Failed to load instance icon:", error);
    }

    // Populate icon picker grids
    function populateIconPicker() {
      Object.entries(ICON_CATEGORIES).forEach(([category, icons]) => {
        const grid = overlay.querySelector(`[data-category="${getCategorySlug(category)}"]`);
        if (!grid) return;

        grid.innerHTML = icons.map(icon => `
          <button class="icon-picker-icon ${icon === currentIcon ? 'selected' : ''}"
                  data-icon="${icon}"
                  type="button">
            <i class="ph ph-${icon}"></i>
          </button>
        `).join('');
      });
    }

    function getCategorySlug(category) {
      return category.toLowerCase().replace(/[^a-z]/g, '');
    }

    // Open modal
    iconBtn.addEventListener("click", () => {
      populateIconPicker();
      overlay.style.display = "flex";
    });

    // Close modal
    function closeModal() {
      overlay.style.display = "none";
    }

    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });

    // Icon selection
    overlay.addEventListener("click", async (e) => {
      const iconBtn = e.target.closest(".icon-picker-icon");
      if (!iconBtn) return;

      const selectedIcon = iconBtn.dataset.icon;

      try {
        const response = await fetch("/api/config/instance-icon", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...addCsrfHeader()
          },
          body: JSON.stringify({ instanceIcon: selectedIcon })
        });

        if (response.ok) {
          currentIcon = selectedIcon;
          iconDisplay.className = `ph ph-${selectedIcon}`;

          // Update selected state in picker
          overlay.querySelectorAll(".icon-picker-icon").forEach(btn => {
            btn.classList.toggle("selected", btn.dataset.icon === selectedIcon);
          });

          // Notify app of icon change
          if (onInstanceIconChange) {
            onInstanceIconChange(selectedIcon);
          }

          closeModal();
        } else {
          const error = await response.json();
          alert(`Failed to update icon: ${error.error}`);
        }
      } catch (error) {
        console.error("Failed to save instance icon:", error);
        alert("Failed to save instance icon");
      }
    });
  }

  /**
   * Initialize toolbar color picker
   */
  async function initToolbarColor() {
    const picker = document.getElementById("toolbar-color-picker");
    if (!picker) return;

    let currentColor = "default";

    // Load current toolbar color
    try {
      const response = await fetch("/api/config");
      const data = await response.json();

      if (data.config && data.config.toolbarColor) {
        currentColor = data.config.toolbarColor;
      }
    } catch (error) {
      console.error("Failed to load toolbar color:", error);
    }

    // Populate color swatches
    picker.innerHTML = TOOLBAR_COLORS.map(({ id, name, color }) => `
      <button class="toolbar-color-swatch ${id === currentColor ? 'selected' : ''}"
              data-color="${id}"
              title="${name}"
              style="background: ${color};"
              type="button"
              aria-label="${name}">
      </button>
    `).join('');

    // Handle color selection
    picker.addEventListener("click", async (e) => {
      const swatch = e.target.closest(".toolbar-color-swatch");
      if (!swatch) return;

      const selectedColor = swatch.dataset.color;

      try {
        const response = await fetch("/api/config/toolbar-color", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...addCsrfHeader()
          },
          body: JSON.stringify({ toolbarColor: selectedColor })
        });

        if (response.ok) {
          currentColor = selectedColor;

          // Update selected state
          picker.querySelectorAll(".toolbar-color-swatch").forEach(btn => {
            btn.classList.toggle("selected", btn.dataset.color === selectedColor);
          });

          // Notify app of color change
          if (onToolbarColorChange) {
            onToolbarColorChange(selectedColor);
          }
        } else {
          const error = await response.json();
          alert(`Failed to update toolbar color: ${error.error}`);
        }
      } catch (error) {
        console.error("Failed to save toolbar color:", error);
        alert("Failed to save toolbar color");
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
    initInstanceIcon();
    initToolbarColor();
    initThemeToggle();
    initLogout();
  }

  return {
    init,
    initInstanceName,
    initInstanceIcon,
    initToolbarColor,
    initThemeToggle,
    initLogout
  };
}
