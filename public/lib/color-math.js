/**
 * Color Math
 *
 * sRGB ↔ Linear RGB ↔ Oklab ↔ OKLCH conversions, gamut clipping, and APCA
 * contrast scoring. Used by the palette generator to derive the entire
 * katulong UI + xterm color palette from a single anchor color.
 *
 * ## Why OKLCH, not HSL
 * HSL is not perceptually uniform — "lightness 50%" yellow looks blinding
 * while "lightness 50%" blue looks nearly black. That makes HSL useless for
 * generating palettes by rotating hue, because the resulting colors have
 * wildly inconsistent perceived brightness. OKLCH (the polar form of Oklab)
 * IS perceptually uniform: L=0.7 looks equally bright at any hue, C (chroma)
 * scales saturation predictably, and H (hue) rotates without changing
 * perceived lightness. Reference: https://bottosson.github.io/posts/oklab/
 *
 * ## Gamut clipping strategy
 * OKLCH is a larger gamut than sRGB, so high-chroma oklch colors can be
 * out-of-gamut when converted back. Rather than naively clamping RGB (which
 * shifts hue and lightness), we preserve (L, H) and binary-search C down
 * until the result falls inside sRGB. This matches CSS Color 4's "chroma
 * reduction" gamut-mapping algorithm.
 *
 * ## APCA, not WCAG 2.1
 * WCAG 2.1 contrast is known to be wrong for dark-mode color pairs —
 * it systematically under-reports contrast for light-on-dark text and over-
 * reports it for dark-on-light. APCA (Accessible Perceptual Contrast
 * Algorithm, the research basis for WCAG 3.0) handles both cases correctly
 * by applying a power curve to luminance before differencing. We use APCA to
 * verify that every generated text/background pair stays legible, and push
 * text lightness further from the background if any pair falls short.
 * Reference: https://git.apcacontrast.com/documentation/APCAeasyIntro
 */

// ── sRGB ↔ linear RGB ───────────────────────────────────────────────────

/** sRGB channel [0,1] → linear-light channel [0,1]. */
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear-light channel [0,1] → sRGB channel [0,1]. */
export function linearToSrgb(v) {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// ── Linear RGB ↔ Oklab (Björn Ottosson, 2020) ──────────────────────────

export function linearRgbToOklab([r, g, b]) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

export function oklabToLinearRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

// ── Oklab ↔ OKLCH (polar form) ──────────────────────────────────────────

export function oklabToOklch([L, a, b]) {
  const C = Math.sqrt(a * a + b * b);
  let H = Math.atan2(b, a) * 180 / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

export function oklchToOklab([L, C, H]) {
  const h = H * Math.PI / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

// ── sRGB ↔ OKLCH (convenience — the common path) ────────────────────────

/** Convert [r,g,b] in [0,1] sRGB to [L, C, H] OKLCH. */
export function srgbToOklch([r, g, b]) {
  const lin = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  return oklabToOklch(linearRgbToOklab(lin));
}

/**
 * Convert OKLCH to sRGB, binary-searching chroma down if the result is
 * out of gamut. L and H are preserved; only C is reduced. This is the
 * CSS Color 4 "reduce chroma until in-gamut" algorithm simplified.
 *
 * Returns [r, g, b] in [0, 1] sRGB, guaranteed in gamut (modulo floating
 * point — callers should still clamp before serializing).
 */
export function oklchToSrgb([L, C, H]) {
  // Fast path: try the requested chroma first
  const tryC = (c) => {
    const lin = oklabToLinearRgb(oklchToOklab([L, c, H]));
    return lin.map(linearToSrgb);
  };

  const inGamut = (rgb, eps = 0.00005) =>
    rgb.every(v => v >= -eps && v <= 1 + eps);

  let rgb = tryC(C);
  if (inGamut(rgb)) return rgb.map(clamp01);

  // Binary search: chroma in [0, C], find largest C' with in-gamut RGB
  let lo = 0;
  let hi = C;
  // 20 iterations ≈ 1e-6 precision, plenty
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    rgb = tryC(mid);
    if (inGamut(rgb)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return tryC(lo).map(clamp01);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Hex ↔ sRGB ──────────────────────────────────────────────────────────

/** Parse "#rgb", "#rrggbb", or "#rrggbbaa" → [r, g, b] in [0, 1] (alpha dropped). */
export function hexToSrgb(hex) {
  if (typeof hex !== "string") throw new TypeError(`hexToSrgb: expected string, got ${typeof hex}`);
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h.split("").map(c => c + c).join("");
  }
  if (h.length !== 6 && h.length !== 8) {
    throw new Error(`hexToSrgb: invalid hex "${hex}"`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`hexToSrgb: invalid hex "${hex}"`);
  }
  return [r / 255, g / 255, b / 255];
}

/** [r, g, b] in [0, 1] → "#rrggbb". */
export function srgbToHex([r, g, b]) {
  const toByte = (v) => {
    const n = Math.round(clamp01(v) * 255);
    return n.toString(16).padStart(2, "0");
  };
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/** OKLCH → "#rrggbb", with gamut clipping. */
export function oklchToHex(lch) {
  return srgbToHex(oklchToSrgb(lch));
}

/** "#rrggbb" → OKLCH. */
export function hexToOklch(hex) {
  return srgbToOklch(hexToSrgb(hex));
}

/** Format an rgba() string from [r, g, b] in [0, 1] and alpha in [0, 1]. */
export function srgbToRgba([r, g, b], alpha) {
  const c = (v) => Math.round(clamp01(v) * 255);
  return `rgba(${c(r)},${c(g)},${c(b)},${+alpha.toFixed(3)})`;
}

/** OKLCH → rgba() with alpha. */
export function oklchToRgba(lch, alpha) {
  return srgbToRgba(oklchToSrgb(lch), alpha);
}

// ── APCA contrast ───────────────────────────────────────────────────────
//
// Implementation tracks SAPC v0.98G-4g constants (the "revised" APCA as
// referenced by WCAG 3 drafts and Adobe/Figma tooling). Lc values are
// signed: positive = dark text on light bg (BoW), negative = light text on
// dark bg (WoB). Callers should compare against |Lc|.
//
// Threshold guidance (from APCA "Bronze" levels):
//   |Lc| >= 90  body copy, any size
//   |Lc| >= 75  body copy at 14pt+
//   |Lc| >= 60  large text, 18pt+ or 14pt bold
//   |Lc| >= 45  non-text UI (buttons, icons)
//   |Lc| <  30  treat as invisible

const APCA_MAIN_TRC = 2.4;
const APCA_RCO = 0.2126729;
const APCA_GCO = 0.7151522;
const APCA_BCO = 0.0721750;
const APCA_NORM_BG = 0.56;
const APCA_NORM_TXT = 0.57;
const APCA_REV_TXT = 0.62;
const APCA_REV_BG = 0.65;
const APCA_BLK_THRS = 0.022;
const APCA_BLK_CLMP = 1.414;
const APCA_SCALE = 1.14;
const APCA_LO_OFFSET = 0.027;
const APCA_LO_CLIP = 0.1;
const APCA_DELTA_Y_MIN = 0.0005;

/** sRGB [r,g,b] in [0,1] → APCA "screen luminance" Y (not CIE Y). */
function apcaY([r, g, b]) {
  return (
    APCA_RCO * Math.pow(clamp01(r), APCA_MAIN_TRC) +
    APCA_GCO * Math.pow(clamp01(g), APCA_MAIN_TRC) +
    APCA_BCO * Math.pow(clamp01(b), APCA_MAIN_TRC)
  );
}

/**
 * APCA contrast Lc for text on background, both as sRGB [r,g,b] in [0,1].
 * Returns a signed value: positive for dark-on-light, negative for
 * light-on-dark. |Lc| ≥ 75 is the rough bar for comfortable body text.
 */
export function apcaContrast(textRgb, bgRgb) {
  let txtY = apcaY(textRgb);
  let bgY = apcaY(bgRgb);

  // Soft black clamp — below this, dark values are perceptually flattened
  if (txtY < APCA_BLK_THRS) {
    txtY += Math.pow(APCA_BLK_THRS - txtY, APCA_BLK_CLMP);
  }
  if (bgY < APCA_BLK_THRS) {
    bgY += Math.pow(APCA_BLK_THRS - bgY, APCA_BLK_CLMP);
  }

  if (Math.abs(bgY - txtY) < APCA_DELTA_Y_MIN) return 0;

  let sapc;
  let lc;
  if (bgY > txtY) {
    // Dark text on lighter background (BoW, "Bronze-on-White")
    sapc = (Math.pow(bgY, APCA_NORM_BG) - Math.pow(txtY, APCA_NORM_TXT)) * APCA_SCALE;
    lc = sapc < APCA_LO_CLIP ? 0 : sapc - APCA_LO_OFFSET;
  } else {
    // Light text on darker background (WoB)
    sapc = (Math.pow(bgY, APCA_REV_BG) - Math.pow(txtY, APCA_REV_TXT)) * APCA_SCALE;
    lc = sapc > -APCA_LO_CLIP ? 0 : sapc + APCA_LO_OFFSET;
  }
  return lc * 100;
}

/** Convenience: APCA contrast between two hex colors. Signed Lc. */
export function apcaHex(textHex, bgHex) {
  return apcaContrast(hexToSrgb(textHex), hexToSrgb(bgHex));
}
