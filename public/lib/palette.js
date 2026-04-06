/**
 * Palette Generator
 *
 * Given a tint color, a polarity (dark | light), and a vibrancy
 * (subtle | colorful), derive the entire katulong palette — every UI CSS
 * custom property and the full 16-color xterm terminal theme — using OKLCH
 * color math.
 *
 * ## Design
 *
 * The palette is parameterized by:
 *   - tint hex color    (user's "signature" color, internally still called "anchor")
 *   - polarity          ("dark" | "light")
 *   - vibrancy          ("subtle" | "colorful")
 *
 * From the tint we extract (L_a, C_a, H_a) in OKLCH. L_a is discarded
 * (the UI decides lightness), but C_a and H_a determine the entire look:
 *
 *   - **Hue** tints every neutral surface (bg, surface, border) with a
 *     wash of H_a, so the UI feels coordinated instead of grey. How much
 *     wash depends on vibrancy — subtle uses a fraction of C_a (enough
 *     presence to read, too little to compete with real accents); colorful
 *     pushes that 3–4× harder so the bg is obviously tinted.
 *
 *   - **Chroma** sets the overall vividness. A muted tint (C=0.04)
 *     produces a muted palette across the board; a vivid tint (C=0.2)
 *     produces a vivid one. This is what makes the palette feel like
 *     *one* design instead of an arbitrary mix.
 *
 *   - **Tint itself** becomes `--accent-active`, the single most
 *     prominent color in the UI (active buttons, focused tabs, cursor).
 *     It is re-lightness-normalized so a very pale or very dark tint
 *     still lands at a readable luminance.
 *
 * ## Subtle vs Colorful
 *
 * Subtle is the default and the original behavior: backgrounds are
 * almost-neutral with a faint hue wash, text is near-grey with a hint of
 * tint, ANSI colors stay calm. The result reads as professional and
 * sophisticated — a "this could be a paid IDE theme" look.
 *
 * Colorful pushes every chroma multiplier 3–4× harder. Backgrounds are
 * obviously tinted, text picks up real color, ANSI colors are vivid. The
 * result reads as expressive and playful — a "Color Hunt" / Synthwave
 * look. Contrast is still verified by APCA so it can't become unreadable.
 *
 * ## Status / ANSI colors snap to canonical hues
 *
 * Red must look red. Green must look green. Rotating those with the
 * anchor's hue would break decades of terminal muscle memory (error =
 * red, git-diff red = removed, etc.). So while the anchor sets the
 * palette's L and C, the H of every ANSI slot is fixed at an OKLCH value
 * that matches human intuition:
 *
 *   red ≈ 27°, green ≈ 145°, yellow ≈ 95°, blue ≈ 257°,
 *   magenta ≈ 328°, cyan ≈ 195°
 *
 * This means a muted anchor gives you muted-but-still-recognizable ANSI
 * colors; a vivid anchor gives you vivid ANSI colors; and a tealish
 * anchor doesn't force red to become teal.
 *
 * ## Contrast guarantees (APCA)
 *
 * After generating the palette, we verify every (text, background) pair
 * against APCA and push the text L further from the bg L if |Lc| falls
 * below the threshold for its role:
 *
 *   text on bg         |Lc| ≥ 75  (body copy)
 *   text-muted on bg   |Lc| ≥ 55  (secondary)
 *   text-dim on bg     |Lc| ≥ 40  (tertiary)
 *   accent on surface  |Lc| ≥ 45  (non-text UI)
 *
 * This means no anchor the user picks can produce an unreadable UI.
 */

import { hexToOklch, oklchToHex, oklchToRgba, apcaHex, hexToSrgb } from "./color-math.js";

// ── Canonical ANSI hues (OKLCH H in degrees) ────────────────────────────
// Tuned against common terminal palettes (Catppuccin, Solarized, Nord,
// One Dark) so the colors feel familiar regardless of anchor.
const ANSI_HUES = {
  red:     27,
  orange:  45,
  yellow:  95,
  green:   145,
  cyan:    195,
  blue:    257,
  magenta: 328,
};

// ── L-ramp profiles (tuned by eye for pleasant defaults) ────────────────
//
// Four ramps total: { dark, light } × { subtle, colorful }. They were
// chosen to produce pleasant palettes across a wide range of tints and
// to give a nice light mode specifically — light generators tend to end
// up washed out because people just invert dark values.
//
// Subtle dark/light mirror Catppuccin Mocha/Latte energy: near-neutral
// surfaces with a faint hue wash. Light-subtle uses pure-white cards on
// a tinted backdrop (Catppuccin Latte style), which reads polished
// instead of flat.
//
// Colorful dark/light push every Cmul/Cabs ~3–4× harder so backgrounds
// are obviously tinted and text picks up real color. Light-colorful
// drops the pure-white trick and uses pastel-tinted cards instead.

const RAMP_DARK_SUBTLE = {
  // Backgrounds: subtle tint wash, very low chroma so they read as
  // "almost black but with warmth". L≈0.19 puts the bg near
  // Catppuccin Mocha's base — dark enough to feel premium but not
  // OLED-black territory.
  bg:         { L: 0.190, Cmul: 0.10 },
  bgInput:    { L: 0.160, Cmul: 0.10 },
  bgSurface:  { L: 0.270, Cmul: 0.12 },
  border:     { L: 0.370, Cmul: 0.14 },
  tagBg:      { L: 0.340, Cmul: 0.14 },
  accentBg:   { L: 0.340, Cmul: 0.14 },  // --accent (button bg, non-active)

  // Foregrounds: very high L, very low chroma (near-neutral)
  text:       { L: 0.930, Cabs: 0.015 },
  textMuted:  { L: 0.760, Cabs: 0.020 },
  textDim:    { L: 0.560, Cabs: 0.025 },

  // Accent (the tint itself, re-lightness-normalized)
  accent:     { L: 0.780 },

  // ANSI palette lightness — bright enough to read on dark bg
  ansi:       { L: 0.780, C: 0.140 },
  ansiBright: { L: 0.850, C: 0.130 },

  // Black/white slot tinting (very low Cmul for "no color" containers)
  blackC:        0.12,
  brightBlackC:  0.12,
  whiteC:        0.06,
  brightWhiteC:  0.04,

  // Overlay & selection alpha
  overlayAlpha: 0.60,
  selectionAlpha: 0.30,
  focusRingAlpha: 0.50,
};

const RAMP_DARK_COLORFUL = {
  // Same lightness anchors as subtle, but the chroma multipliers are
  // pushed 3–4× — the bg is no longer "tinted grey", it's a deep saturated
  // version of the tint hue. Reads as expressive and synthwave-y.
  //
  // Cmin is the floor: even if the user picks a desaturated tint (like
  // the default mauve at C≈0.10), Cmin guarantees a visible chroma. For
  // saturated tints (orange, true red) Cmul wins and Cmin doesn't bind.
  bg:         { L: 0.190, Cmul: 0.50, Cmin: 0.090 },
  bgInput:    { L: 0.160, Cmul: 0.55, Cmin: 0.095 },
  bgSurface:  { L: 0.270, Cmul: 0.55, Cmin: 0.110 },
  border:     { L: 0.370, Cmul: 0.65, Cmin: 0.130 },
  tagBg:      { L: 0.340, Cmul: 0.60, Cmin: 0.120 },
  accentBg:   { L: 0.340, Cmul: 0.65, Cmin: 0.125 },

  // Text picks up real color — no longer trying to be neutral.
  text:       { L: 0.940, Cabs: 0.060 },
  textMuted:  { L: 0.770, Cabs: 0.090 },
  textDim:    { L: 0.580, Cabs: 0.105 },

  accent:     { L: 0.795 },

  // ANSI: noticeably more saturated than subtle.
  ansi:       { L: 0.770, C: 0.190 },
  ansiBright: { L: 0.850, C: 0.180 },

  blackC:        0.45,
  brightBlackC:  0.45,
  whiteC:        0.20,
  brightWhiteC:  0.15,

  overlayAlpha: 0.65,
  selectionAlpha: 0.35,
  focusRingAlpha: 0.55,
};

const RAMP_LIGHT_SUBTLE = {
  // Light-subtle uses a slightly tinted bg under pure-white surfaces —
  // same trick as Catppuccin Latte, which reads polished instead of the
  // washed-out look most generated light themes suffer from.
  bg:         { L: 0.965, Cmul: 0.08 },
  bgInput:    { L: 0.935, Cmul: 0.08 },
  bgSurface:  { L: 1.000, Cmul: 0.00 },  // pure white cards on tinted bg
  border:     { L: 0.870, Cmul: 0.14 },
  tagBg:      { L: 0.915, Cmul: 0.10 },
  accentBg:   { L: 0.880, Cmul: 0.12 },

  text:       { L: 0.300, Cabs: 0.020 },
  textMuted:  { L: 0.450, Cabs: 0.025 },
  textDim:    { L: 0.600, Cabs: 0.030 },

  accent:     { L: 0.500 },

  // ANSI on light bg needs to be DARK, not bright — otherwise yellow
  // and cyan disappear into the background.
  ansi:       { L: 0.500, C: 0.150 },
  ansiBright: { L: 0.430, C: 0.165 },

  blackC:        0.10,
  brightBlackC:  0.10,
  whiteC:        0.05,
  brightWhiteC:  0.04,

  overlayAlpha: 0.35,
  selectionAlpha: 0.20,
  focusRingAlpha: 0.45,
};

const RAMP_LIGHT_COLORFUL = {
  // Light-colorful drops the pure-white trick and uses pastel-tinted
  // surfaces. Think "Color Hunt" / Tailwind pastel. Cmin floors guarantee
  // visible tint even for desaturated anchors (see DARK_COLORFUL note).
  bg:         { L: 0.955, Cmul: 0.40, Cmin: 0.055 },
  bgInput:    { L: 0.925, Cmul: 0.45, Cmin: 0.065 },
  bgSurface:  { L: 0.980, Cmul: 0.30, Cmin: 0.040 },  // pastel tinted, not pure white
  border:     { L: 0.840, Cmul: 0.60, Cmin: 0.090 },
  tagBg:      { L: 0.895, Cmul: 0.45, Cmin: 0.075 },
  accentBg:   { L: 0.855, Cmul: 0.55, Cmin: 0.090 },

  text:       { L: 0.290, Cabs: 0.075 },
  textMuted:  { L: 0.440, Cabs: 0.100 },
  textDim:    { L: 0.590, Cabs: 0.110 },

  accent:     { L: 0.490 },

  ansi:       { L: 0.490, C: 0.190 },
  ansiBright: { L: 0.420, C: 0.200 },

  blackC:        0.30,
  brightBlackC:  0.30,
  whiteC:        0.15,
  brightWhiteC:  0.10,

  overlayAlpha: 0.40,
  selectionAlpha: 0.25,
  focusRingAlpha: 0.50,
};

const RAMPS = {
  dark:  { subtle: RAMP_DARK_SUBTLE,  colorful: RAMP_DARK_COLORFUL  },
  light: { subtle: RAMP_LIGHT_SUBTLE, colorful: RAMP_LIGHT_COLORFUL },
};

// ── Contrast thresholds (|Lc| in APCA) ──────────────────────────────────
const CONTRAST_MIN = {
  text: 75,
  textMuted: 55,
  textDim: 40,
  accent: 45,
};

// ── Helpers ─────────────────────────────────────────────────────────────

function neutral(ramp, slot, anchorC, anchorH) {
  // Three chroma modes:
  //   "Cabs" → fixed absolute chroma (near-neutral text in subtle mode)
  //   "Cmul" → fraction of anchor chroma (so muted anchors → muted ui)
  //   "Cmin" → floor under Cmul, so even desaturated anchors produce a
  //            visible tint in colorful mode. Without this, picking the
  //            default mauve (C≈0.10) and toggling Subtle→Colorful makes
  //            almost no visible difference because 0.10 × 0.4 = 0.04.
  const spec = ramp[slot];
  if (spec.Cabs !== undefined) return [spec.L, spec.Cabs, anchorH];
  let C = anchorC * spec.Cmul;
  if (spec.Cmin !== undefined && C < spec.Cmin) C = spec.Cmin;
  return [spec.L, C, anchorH];
}

/**
 * Push a foreground L away from a background L until APCA |Lc| meets the
 * threshold. Direction depends on polarity (dark polarity → push L higher;
 * light → push L lower). Gives up after 10 iterations and returns whatever
 * it reached — we'd rather have a slightly too-low-contrast color than
 * hang the browser on pathological inputs.
 */
function ensureContrast(textLch, bgHex, polarity, minLc) {
  const step = 0.03;
  let [L, C, H] = textLch;
  for (let i = 0; i < 10; i++) {
    const hex = oklchToHex([L, C, H]);
    const lc = Math.abs(apcaHex(hex, bgHex));
    if (lc >= minLc) return [L, C, H];
    if (polarity === "dark") {
      L = Math.min(1, L + step);
    } else {
      L = Math.max(0, L - step);
    }
  }
  return [L, C, H];
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a full palette from a tint color, polarity, and vibrancy.
 *
 * @param {string} anchorHex — "#rrggbb" user tint color (called "anchor" internally for backward compat)
 * @param {"dark"|"light"} polarity
 * @param {"subtle"|"colorful"} [vibrancy="subtle"]
 * @returns {{
 *   cssVars: Object<string, string>,  // CSS custom property values keyed without "--"
 *   xterm: Object,                    // xterm.js theme object (16 colors + bg/fg/cursor/sel)
 *   anchor: string,                   // normalized tint hex
 *   polarity: "dark"|"light",
 *   vibrancy: "subtle"|"colorful",
 *   meta: Object,                     // derived OKLCH of the tint, for debugging
 * }}
 */
export function generatePalette(anchorHex, polarity, vibrancy = "subtle") {
  if (polarity !== "dark" && polarity !== "light") {
    throw new Error(`generatePalette: polarity must be "dark" or "light", got ${polarity}`);
  }
  if (vibrancy !== "subtle" && vibrancy !== "colorful") {
    throw new Error(`generatePalette: vibrancy must be "subtle" or "colorful", got ${vibrancy}`);
  }
  const [, Ca, Ha] = hexToOklch(anchorHex);
  const ramp = RAMPS[polarity][vibrancy];

  // 1. Backgrounds (neutrals tinted with anchor hue + small chroma fraction)
  const bg        = neutral(ramp, "bg",        Ca, Ha);
  const bgInput   = neutral(ramp, "bgInput",   Ca, Ha);
  const bgSurface = neutral(ramp, "bgSurface", Ca, Ha);
  const border    = neutral(ramp, "border",    Ca, Ha);
  const tagBg     = neutral(ramp, "tagBg",     Ca, Ha);
  const accentBg  = neutral(ramp, "accentBg",  Ca, Ha);

  const bgHex        = oklchToHex(bg);
  const bgSurfaceHex = oklchToHex(bgSurface);

  // 2. Text ramp (near-neutral, verified against bg contrast)
  let text      = neutral(ramp, "text",      Ca, Ha);
  let textMuted = neutral(ramp, "textMuted", Ca, Ha);
  let textDim   = neutral(ramp, "textDim",   Ca, Ha);

  text      = ensureContrast(text,      bgHex, polarity, CONTRAST_MIN.text);
  textMuted = ensureContrast(textMuted, bgHex, polarity, CONTRAST_MIN.textMuted);
  textDim   = ensureContrast(textDim,   bgHex, polarity, CONTRAST_MIN.textDim);

  // 3. Accent (the anchor, but re-lightness-normalized so pale/dark
  // anchors still show up). Chroma is preserved so the user's "vividness"
  // choice carries through; we just guarantee readable L.
  let accent = [ramp.accent.L, Ca, Ha];
  accent = ensureContrast(accent, bgSurfaceHex, polarity, CONTRAST_MIN.accent);
  const accentHex = oklchToHex(accent);

  // 4. ANSI palette: canonical hues, L and C from ramp (normalized to
  // anchor's energy via ramp.ansi.C — but not literally the anchor's C,
  // so terminal output stays consistent even if the anchor is very pale).
  const ansi = (hue, bright = false) => {
    const spec = bright ? ramp.ansiBright : ramp.ansi;
    return oklchToHex([spec.L, spec.C, hue]);
  };

  // 5. black/white slots derive from the neutral ramp (not hue-rotated) —
  // they're containers for "no color", so they pick up tint hue but not
  // tint chroma. The chroma multipliers come from the ramp so colorful
  // mode can push them harder than subtle.
  const blackL       = polarity === "dark" ? 0.350 : 0.250;
  const brightBlackL = polarity === "dark" ? 0.430 : 0.360;
  const whiteL       = polarity === "dark" ? 0.790 : 0.680;
  const brightWhiteL = polarity === "dark" ? 0.860 : 0.780;

  const blackHex       = oklchToHex([blackL,       Ca * ramp.blackC,       Ha]);
  const brightBlackHex = oklchToHex([brightBlackL, Ca * ramp.brightBlackC, Ha]);
  const whiteHex       = oklchToHex([whiteL,       Ca * ramp.whiteC,       Ha]);
  const brightWhiteHex = oklchToHex([brightWhiteL, Ca * ramp.brightWhiteC, Ha]);

  // 6. Status colors (success/warning/danger) come from the ANSI palette
  // so they feel coordinated with the terminal output. We use the
  // non-bright variants so they stay calm and on-brand.
  const success = ansi(ANSI_HUES.green);
  const warning = ansi(ANSI_HUES.yellow);
  const danger  = ansi(ANSI_HUES.red);

  // 7. Cursor: the accent color at slightly elevated L for visibility.
  const cursor = oklchToHex([
    polarity === "dark" ? Math.min(0.92, accent[0] + 0.08) : Math.max(0.30, accent[0] - 0.12),
    accent[1],
    accent[2],
  ]);

  // 8. Overlay, selection, focus ring — alpha variants of bg or accent
  const overlayBg   = polarity === "dark"
    ? `rgba(0,0,0,${ramp.overlayAlpha})`
    : `rgba(0,0,0,${ramp.overlayAlpha})`;
  const selectionBg = oklchToRgba(accent, ramp.selectionAlpha);
  const focusRing   = oklchToRgba(accent, ramp.focusRingAlpha);

  // 9. Terminal background uses the SAME RGB as --bg but with alpha=0 so
  // the parent tile paints through. xterm's minimumContrastRatio computes
  // against the RGB regardless of alpha, so keeping RGB=bg preserves
  // text legibility math even when the tile is transparent.
  const [bgR, bgG, bgB] = hexToSrgb(bgHex);
  const termBackground = `rgba(${Math.round(bgR * 255)},${Math.round(bgG * 255)},${Math.round(bgB * 255)},0)`;

  return {
    anchor: anchorHex,
    polarity,
    vibrancy,
    cssVars: {
      bg:            bgHex,
      "bg-surface":  bgSurfaceHex,
      "bg-input":    oklchToHex(bgInput),
      border:        oklchToHex(border),
      text:          oklchToHex(text),
      "text-muted":  oklchToHex(textMuted),
      "text-dim":    oklchToHex(textDim),
      accent:        oklchToHex(accentBg),
      "accent-active": accentHex,
      success,
      warning,
      danger,
      "overlay-bg":  overlayBg,
      "focus-ring":  focusRing,
      "tag-bg":      oklchToHex(tagBg),
    },
    xterm: {
      background: termBackground,
      foreground: oklchToHex(text),
      cursor,
      selectionBackground: selectionBg,

      black:         blackHex,
      brightBlack:   brightBlackHex,
      red:           ansi(ANSI_HUES.red),
      brightRed:     ansi(ANSI_HUES.red, true),
      green:         ansi(ANSI_HUES.green),
      brightGreen:   ansi(ANSI_HUES.green, true),
      yellow:        ansi(ANSI_HUES.yellow),
      brightYellow:  ansi(ANSI_HUES.yellow, true),
      blue:          ansi(ANSI_HUES.blue),
      brightBlue:    ansi(ANSI_HUES.blue, true),
      magenta:       ansi(ANSI_HUES.magenta),
      brightMagenta: ansi(ANSI_HUES.magenta, true),
      cyan:          ansi(ANSI_HUES.cyan),
      brightCyan:    ansi(ANSI_HUES.cyan, true),
      white:         whiteHex,
      brightWhite:   brightWhiteHex,
    },
    meta: { anchorC: Ca, anchorH: Ha },
  };
}

