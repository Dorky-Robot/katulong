/**
 * Generic Theme Manager
 *
 * Composable theme switching with auto/light/dark modes.
 */

export const DARK_THEME = {
  background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
  selectionBackground: "rgba(137,180,250,0.3)",
  black: "#45475a", brightBlack: "#585b70",
  red: "#f38ba8", brightRed: "#f38ba8",
  green: "#a6e3a1", brightGreen: "#a6e3a1",
  yellow: "#f9e2af", brightYellow: "#f9e2af",
  blue: "#89b4fa", brightBlue: "#89b4fa",
  magenta: "#f5c2e7", brightMagenta: "#f5c2e7",
  cyan: "#94e2d5", brightCyan: "#94e2d5",
  white: "#bac2de", brightWhite: "#a6adc8",
};

export const LIGHT_THEME = {
  background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78",
  selectionBackground: "rgba(30,102,245,0.2)",
  black: "#5c5f77", brightBlack: "#6c6f85",
  red: "#d20f39", brightRed: "#d20f39",
  green: "#40a02b", brightGreen: "#40a02b",
  yellow: "#df8e1d", brightYellow: "#df8e1d",
  blue: "#1e66f5", brightBlue: "#1e66f5",
  magenta: "#ea76cb", brightMagenta: "#ea76cb",
  cyan: "#179299", brightCyan: "#179299",
  white: "#acb0be", brightWhite: "#bcc0cc",
};

/**
 * Create theme manager
 */
export function createThemeManager(options = {}) {
  const {
    storageKey = 'theme',
    themes = { light: LIGHT_THEME, dark: DARK_THEME },
    onThemeChange
  } = options;

  const getEffectiveTheme = () => {
    const pref = localStorage.getItem(storageKey) || "auto";
    return pref === "auto"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : pref;
  };

  const applyTheme = (pref) => {
    localStorage.setItem(storageKey, pref);
    document.documentElement.setAttribute("data-theme", pref);
    const effective = getEffectiveTheme();

    // Update theme color meta tag
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.content = effective === "light" ? "#eff1f5" : "#1e1e2e";
    }

    // Update toggle buttons
    document.querySelectorAll(".theme-toggle button").forEach(btn => {
      const active = btn.dataset.themeVal === pref;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active);
    });

    // Callback with theme data
    if (onThemeChange) {
      const themeData = themes[effective] || themes.dark;
      onThemeChange(themeData, effective, pref);
    }
  };

  // Watch system preference changes
  const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  const handleSystemThemeChange = () => {
    if ((localStorage.getItem(storageKey) || "auto") === "auto") {
      applyTheme("auto");
    }
  };

  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener("change", handleSystemThemeChange);
  } else {
    mediaQuery.addListener(handleSystemThemeChange);
  }

  return {
    apply: applyTheme,
    getEffective: getEffectiveTheme,
    getCurrentPreference: () => localStorage.getItem(storageKey) || "auto"
  };
}
