/**
 * Settings Handlers
 *
 * Composable settings event handlers for theme and logout.
 */

import { api } from "/lib/api-client.js";

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
  async function initInstanceName(config) {
    const input = document.getElementById("instance-name-input");
    if (!input) return;

    if (config && config.instanceName) {
      input.value = config.instanceName;
      document.title = `Katulong — ${config.instanceName}`;
    }

    if (config && config.instanceIcon && onInstanceIconChange) {
      onInstanceIconChange(config.instanceIcon);
    }

    if (config && config.toolbarColor && onToolbarColorChange) {
      onToolbarColorChange(config.toolbarColor);
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
        const data = await api.put("/api/config/instance-name", { instanceName });
        input.dataset.previousValue = data.instanceName;

        // Update document title
        document.title = `Katulong — ${data.instanceName}`;

        if (onInstanceNameChange) {
          onInstanceNameChange(data.instanceName);
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
  async function initInstanceIcon(config) {
    const iconBtn = document.getElementById("instance-icon-btn");
    const iconDisplay = document.getElementById("instance-icon-display");
    const overlay = document.getElementById("icon-picker-overlay");
    const closeBtn = document.getElementById("icon-picker-close");

    if (!iconBtn || !iconDisplay || !overlay || !closeBtn) return;

    let currentIcon = "terminal-window";

    if (config && config.instanceIcon) {
      currentIcon = config.instanceIcon.replace(/[^a-z0-9-]/g, "");
      iconDisplay.className = `ph ph-${currentIcon}`;
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
        await api.put("/api/config/instance-icon", { instanceIcon: selectedIcon });

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
      } catch (error) {
        console.error("Failed to save instance icon:", error);
        alert("Failed to save instance icon");
      }
    });
  }

  /**
   * Initialize toolbar color picker
   */
  async function initToolbarColor(config) {
    const picker = document.getElementById("toolbar-color-picker");
    if (!picker) return;

    let currentColor = "default";

    if (config && config.toolbarColor) {
      currentColor = config.toolbarColor;
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
        await api.put("/api/config/toolbar-color", { toolbarColor: selectedColor });

        currentColor = selectedColor;

        // Update selected state
        picker.querySelectorAll(".toolbar-color-swatch").forEach(btn => {
          btn.classList.toggle("selected", btn.dataset.color === selectedColor);
        });

        // Notify app of color change
        if (onToolbarColorChange) {
          onToolbarColorChange(selectedColor);
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
      await api.post("/auth/logout");

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
    initInstanceName(config);
    initInstanceIcon(config);
    initToolbarColor(config);
    initThemeToggle();
    initLogout();
    initVersion();
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
