/**
 * Palette Manager
 *
 * Historically this module was a "theme manager" that switched between two
 * hardcoded Catppuccin palettes (Mocha / Latte). It now owns a single
 * derived palette: the user picks a **tint color**, a **polarity**
 * ("auto" | "dark" | "light"), and a **vibrancy** ("subtle" | "colorful"),
 * and we generate every UI CSS variable and the xterm 16-color terminal
 * theme from those inputs using the perceptually-uniform OKLCH color
 * space (see lib/palette.js).
 *
 * The "theme-manager" name is kept for the file so existing imports in
 * app.js and settings-handlers.js don't churn during this refactor, but
 * everything inside is now about palettes. The internal field is still
 * called "anchor" — that's the parameter name in palette.js's API.
 *
 * ## Persistence
 *
 *   localStorage["katulong-palette"] = {
 *     "anchor": "#cba6f7", "polarity": "auto", "vibrancy": "subtle"
 *   }
 *
 * On boot we migrate the legacy `"theme"` key: "dark"/"light"/"auto" →
 * same polarity with the Catppuccin mauve default tint. The old key is
 * removed after migration so users don't see stale data in devtools.
 * Older `katulong-palette` entries without a `vibrancy` field default to
 * "subtle" (same as the original behavior).
 *
 * ## Effective polarity
 *
 * "auto" follows `prefers-color-scheme`. When the OS flips, we regenerate
 * the palette (NOT just invert colors — the generator has separate L-ramp
 * profiles for dark vs light that make each polarity look native).
 */

import { generatePalette } from "./palette.js";

const STORAGE_KEY = "katulong-palette";
const LEGACY_KEY = "theme";

// Catppuccin Mocha mauve — a pleasant default that preserves the look of
// pre-palette katulong for users who don't change anything.
export const DEFAULT_ANCHOR = "#cba6f7";
export const DEFAULT_POLARITY = "auto";
export const DEFAULT_VIBRANCY = "subtle";

/** Read + validate settings from localStorage, with legacy migration. */
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object"
          && typeof parsed.anchor === "string"
          && /^#[0-9a-fA-F]{6}$/.test(parsed.anchor)
          && (parsed.polarity === "auto" || parsed.polarity === "dark" || parsed.polarity === "light")) {
        // vibrancy is optional for backward compat with the original
        // {anchor, polarity}-only schema — older entries default to subtle
        // so the saved palette renders identically.
        const vibrancy = (parsed.vibrancy === "subtle" || parsed.vibrancy === "colorful")
          ? parsed.vibrancy
          : DEFAULT_VIBRANCY;
        return { anchor: parsed.anchor, polarity: parsed.polarity, vibrancy };
      }
    }
    // Migrate legacy "theme" key
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy === "dark" || legacy === "light" || legacy === "auto") {
      const migrated = { anchor: DEFAULT_ANCHOR, polarity: legacy, vibrancy: DEFAULT_VIBRANCY };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_KEY);
      } catch { /* quota / privacy mode — fall through with migrated in-memory */ }
      return migrated;
    }
  } catch { /* corrupt JSON, unavailable storage — fall through to defaults */ }
  return { anchor: DEFAULT_ANCHOR, polarity: DEFAULT_POLARITY, vibrancy: DEFAULT_VIBRANCY };
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* quota / privacy mode — no persistence, but current session still works */ }
}

/** Resolve "auto" to the concrete polarity based on prefers-color-scheme. */
function resolvePolarity(polarity) {
  if (polarity !== "auto") return polarity;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Apply generated CSS variable values to document.documentElement.
 * Sets both custom properties (--bg, --text, etc.) and the data-theme
 * attribute (so any CSS still conditionally styling on [data-theme] keeps
 * working during the transition).
 */
function applyCssVars(cssVars, effectivePolarity) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssVars)) {
    root.style.setProperty(`--${name}`, value);
  }
  root.setAttribute("data-theme", effectivePolarity);
}

/**
 * Update the `<meta name="theme-color">` tags so the iOS PWA status bar
 * and Android address bar match the current palette. We use the surface
 * color (what the shortcut bar paints) so the chrome feels continuous.
 */
function applyMetaThemeColor(surfaceHex) {
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.setAttribute("content", surfaceHex);
  });
}

/**
 * Create the palette manager.
 *
 * @param {object} [options]
 * @param {(xtermTheme: object, effective: string, settings: object) => void} [options.onThemeChange]
 *   Callback fired whenever the effective palette changes (anchor, polarity,
 *   or OS preference flip). Passes the xterm theme object, the resolved
 *   polarity ("dark" | "light"), and the current {anchor, polarity}.
 */
export function createThemeManager(options = {}) {
  const { onThemeChange } = options;

  let settings = loadSettings();
  let currentPalette = null;

  /**
   * Regenerate the palette and push it to CSS / meta tags.
   *
   * `notify=true` (the default) also fires onThemeChange — that's how
   * subsequent changes (setAnchor, setPolarity, OS flip) propagate to
   * xterm theme updates and the settings UI sync.
   *
   * `notify=false` is used for the initial synchronous call from the
   * constructor: at that moment the caller's terminalPool may not yet
   * exist (it's typically declared after createThemeManager returns),
   * so firing the callback would hit a TDZ error. Callers always
   * read the initial xterm theme directly via `getPalette().xterm`
   * when they construct their terminal pool, so the missed callback
   * is harmless.
   */
  function regenerate(notify = true) {
    const effective = resolvePolarity(settings.polarity);
    currentPalette = generatePalette(settings.anchor, effective, settings.vibrancy);
    applyCssVars(currentPalette.cssVars, effective);
    applyMetaThemeColor(currentPalette.cssVars["bg-surface"]);
    if (notify && onThemeChange) {
      onThemeChange(currentPalette.xterm, effective, { ...settings });
    }
    return currentPalette;
  }

  /**
   * Set the anchor color (hex). Triggers regeneration + onThemeChange.
   */
  function setAnchor(anchorHex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(anchorHex)) {
      throw new Error(`setAnchor: expected #rrggbb, got ${anchorHex}`);
    }
    settings = { ...settings, anchor: anchorHex };
    saveSettings(settings);
    return regenerate();
  }

  /**
   * Set the polarity. "auto" follows OS preference; "dark" and "light"
   * override it. Triggers regeneration + onThemeChange.
   */
  function setPolarity(polarity) {
    if (polarity !== "auto" && polarity !== "dark" && polarity !== "light") {
      throw new Error(`setPolarity: expected auto|dark|light, got ${polarity}`);
    }
    settings = { ...settings, polarity };
    saveSettings(settings);
    return regenerate();
  }

  /**
   * Set the vibrancy. "subtle" gives near-neutral surfaces with a faint
   * tint wash (sophisticated/professional look); "colorful" pushes every
   * chroma multiplier 3–4× harder for an expressive/playful look. APCA
   * contrast guarantees still hold in both modes.
   */
  function setVibrancy(vibrancy) {
    if (vibrancy !== "subtle" && vibrancy !== "colorful") {
      throw new Error(`setVibrancy: expected subtle|colorful, got ${vibrancy}`);
    }
    settings = { ...settings, vibrancy };
    saveSettings(settings);
    return regenerate();
  }

  // Watch OS preference changes — only re-apply when polarity is "auto"
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onMqChange = () => {
    if (settings.polarity === "auto") regenerate();
  };
  if (mq.addEventListener) {
    mq.addEventListener("change", onMqChange);
  } else if (mq.addListener) {
    mq.addListener(onMqChange);
  }

  // Initial application — do this synchronously so first paint has the
  // right colors instead of flashing the :root defaults. Pass notify=false
  // because the caller hasn't finished wiring up its terminal pool yet:
  // the initial xterm theme is read directly via getPalette().xterm when
  // the pool is constructed, immediately after this function returns.
  regenerate(false);

  return {
    // ── Palette API (new) ────────────────────────────────────────────
    setAnchor,
    setPolarity,
    setVibrancy,
    getAnchor: () => settings.anchor,
    getPolarity: () => settings.polarity,
    getVibrancy: () => settings.vibrancy,
    getPalette: () => currentPalette,

    // ── Legacy compatibility shims ───────────────────────────────────
    // Existing callers (settings-handlers, app.js) call `apply(pref)` with
    // "auto"/"dark"/"light" — reroute those to setPolarity. `getEffective`
    // returns the concrete polarity for consumers that need to know
    // whether they're in dark or light right now.
    apply: (pref) => setPolarity(pref),
    getEffective: () => resolvePolarity(settings.polarity),
    getCurrentPreference: () => settings.polarity,
  };
}
