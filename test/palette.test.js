/**
 * Tests for the palette system: color-math conversions, palette generation,
 * contrast guarantees, and the xterm theme shape.
 *
 * These are pure-math tests — no DOM, no localStorage. theme-manager.js has
 * runtime dependencies on window/document/localStorage that we don't want
 * to mock here, so those are covered by the integration smoke test
 * (test/e2e/smoke.e2e.js) and by card-carousel-style DOM mocks in a
 * future pass if needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  srgbToLinear,
  linearToSrgb,
  hexToSrgb,
  srgbToHex,
  hexToOklch,
  oklchToHex,
  srgbToOklch,
  oklchToSrgb,
  apcaHex,
  apcaContrast,
} from '../public/lib/color-math.js';

import { generatePalette } from '../public/lib/palette.js';

// ── color-math ──────────────────────────────────────────────────────────

describe('color-math: sRGB / linear round trips', () => {
  it('srgbToLinear / linearToSrgb are inverses across [0,1]', () => {
    // Tolerance is 1e-6, not machine epsilon: the sRGB transfer curve is
    // piecewise with a seam at 0.04045, and the analytic inverse of the
    // gamma-2.4 branch introduces sub-nano drift that we don't care about
    // (it's well below 1/255, so it never produces a visible channel shift).
    for (const v of [0, 0.02, 0.04045, 0.1, 0.5, 0.8, 1]) {
      const back = linearToSrgb(srgbToLinear(v));
      assert.ok(Math.abs(back - v) < 1e-6, `roundtrip ${v} → ${back}`);
    }
  });
});

describe('color-math: hex parsing', () => {
  it('parses #rrggbb', () => {
    assert.deepEqual(hexToSrgb('#ff0000'), [1, 0, 0]);
    assert.deepEqual(hexToSrgb('#00ff00'), [0, 1, 0]);
    assert.deepEqual(hexToSrgb('#0000ff'), [0, 0, 1]);
  });

  it('parses #rgb shorthand', () => {
    assert.deepEqual(hexToSrgb('#f00'), [1, 0, 0]);
    assert.deepEqual(hexToSrgb('#0f0'), [0, 1, 0]);
  });

  it('accepts #rrggbbaa but drops alpha', () => {
    assert.deepEqual(hexToSrgb('#ff000080'), [1, 0, 0]);
  });

  it('throws on invalid input', () => {
    assert.throws(() => hexToSrgb('not a color'));
    assert.throws(() => hexToSrgb('#xyz'));
    assert.throws(() => hexToSrgb(null));
  });

  it('serializes via srgbToHex with padding', () => {
    assert.equal(srgbToHex([0, 0, 0]), '#000000');
    assert.equal(srgbToHex([1, 1, 1]), '#ffffff');
    assert.equal(srgbToHex([1, 0, 0]), '#ff0000');
  });
});

describe('color-math: OKLCH round trips', () => {
  it('hex → OKLCH → hex is byte-exact for common colors', () => {
    const samples = [
      '#000000', '#ffffff',
      '#ff0000', '#00ff00', '#0000ff',
      '#cba6f7', // catppuccin mauve
      '#1e1e2e', // catppuccin base
      '#eff1f5', // catppuccin latte base
      '#8839ef', // latte mauve
      '#40a02b', // latte green
    ];
    for (const hex of samples) {
      const back = oklchToHex(hexToOklch(hex));
      assert.equal(back, hex, `${hex} round-trip → ${back}`);
    }
  });

  it('OKLCH hue for pure red lands near 29°', () => {
    const [, , H] = hexToOklch('#ff0000');
    assert.ok(H > 27 && H < 32, `expected red H ≈ 29, got ${H}`);
  });

  it('OKLCH hue for pure green lands near 142°', () => {
    const [, , H] = hexToOklch('#00ff00');
    assert.ok(H > 140 && H < 145, `expected green H ≈ 142, got ${H}`);
  });

  it('OKLCH hue for pure blue lands near 264°', () => {
    const [, , H] = hexToOklch('#0000ff');
    assert.ok(H > 261 && H < 266, `expected blue H ≈ 264, got ${H}`);
  });
});

describe('color-math: gamut clipping', () => {
  it('clips high-chroma OKLCH colors back into sRGB', () => {
    // A ludicrously saturated OKLCH that is well outside sRGB
    const rgb = oklchToSrgb([0.7, 0.4, 30]);
    for (const v of rgb) {
      assert.ok(v >= 0 && v <= 1, `out-of-gamut channel ${v}`);
    }
  });

  it('preserves in-gamut colors unchanged', () => {
    // A color we know is in-gamut
    const lch = hexToOklch('#80a0c0');
    const back = oklchToSrgb(lch);
    const target = hexToSrgb('#80a0c0');
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - target[i]) < 1 / 255, `channel ${i} drifted`);
    }
  });
});

describe('color-math: APCA contrast', () => {
  it('white on black is strongly negative (light-on-dark)', () => {
    assert.ok(apcaHex('#ffffff', '#000000') < -100);
  });

  it('black on white is strongly positive (dark-on-light)', () => {
    assert.ok(apcaHex('#000000', '#ffffff') > 100);
  });

  it('identical colors return 0', () => {
    assert.equal(apcaHex('#808080', '#808080'), 0);
  });

  it('Catppuccin text/bg pair exceeds body-copy threshold', () => {
    assert.ok(Math.abs(apcaHex('#cdd6f4', '#1e1e2e')) >= 75);
  });

  it('apcaContrast accepts [r,g,b] directly', () => {
    const lc = apcaContrast([1, 1, 1], [0, 0, 0]);
    assert.ok(lc < -100);
  });
});

// ── palette generator ───────────────────────────────────────────────────

describe('generatePalette: shape', () => {
  it('returns cssVars, xterm, anchor, polarity', () => {
    const p = generatePalette('#cba6f7', 'dark');
    assert.equal(p.anchor, '#cba6f7');
    assert.equal(p.polarity, 'dark');
    assert.equal(typeof p.cssVars, 'object');
    assert.equal(typeof p.xterm, 'object');
  });

  it('contains all 14 UI CSS vars expected by index.html', () => {
    const p = generatePalette('#cba6f7', 'dark');
    const required = [
      'bg', 'bg-surface', 'bg-input', 'border',
      'text', 'text-muted', 'text-dim',
      'accent', 'accent-active',
      'success', 'warning', 'danger',
      'overlay-bg', 'focus-ring', 'tag-bg',
    ];
    for (const key of required) {
      assert.ok(p.cssVars[key], `missing --${key}`);
    }
  });

  it('contains the full xterm 16-color palette plus bg/fg/cursor/selection', () => {
    const p = generatePalette('#cba6f7', 'dark');
    const required = [
      'background', 'foreground', 'cursor', 'selectionBackground',
      'black', 'brightBlack',
      'red', 'brightRed',
      'green', 'brightGreen',
      'yellow', 'brightYellow',
      'blue', 'brightBlue',
      'magenta', 'brightMagenta',
      'cyan', 'brightCyan',
      'white', 'brightWhite',
    ];
    for (const key of required) {
      assert.ok(p.xterm[key], `missing xterm.${key}`);
    }
  });

  it('terminal background uses alpha=0 with RGB matching --bg', () => {
    // xterm's minimumContrastRatio computes against RGB regardless of
    // alpha — so the RGB must match --bg for text legibility math.
    const p = generatePalette('#cba6f7', 'dark');
    const match = p.xterm.background.match(/^rgba\((\d+),(\d+),(\d+),0\)$/);
    assert.ok(match, `expected rgba(...,0) got ${p.xterm.background}`);
    const bgRgb = hexToSrgb(p.cssVars.bg).map(v => Math.round(v * 255));
    assert.deepEqual(
      [Number(match[1]), Number(match[2]), Number(match[3])],
      bgRgb,
      'terminal background RGB must match --bg hex'
    );
  });

  it('rejects invalid polarity', () => {
    assert.throws(() => generatePalette('#cba6f7', 'neon'));
  });
});

describe('generatePalette: contrast guarantees', () => {
  // For every reasonable anchor and both polarities, the generator MUST
  // produce (text, bg) pairs that pass APCA thresholds. This is the
  // headline feature — picking a color must never produce an unreadable UI.
  const anchors = [
    '#cba6f7', // mauve (katulong default)
    '#8839ef', // latte mauve
    '#5b8b8b', // muted teal
    '#ff6b35', // orange
    '#40a02b', // green
    '#1e66f5', // blue
    '#d20f39', // red
    '#111122', // near-black
    '#fff0ee', // pale peach
    '#808080', // neutral grey
  ];

  for (const anchor of anchors) {
    for (const polarity of ['dark', 'light']) {
      it(`${anchor} ${polarity} passes contrast thresholds`, () => {
        const p = generatePalette(anchor, polarity);
        const textLc = Math.abs(apcaHex(p.cssVars.text, p.cssVars.bg));
        const mutedLc = Math.abs(apcaHex(p.cssVars['text-muted'], p.cssVars.bg));
        const dimLc = Math.abs(apcaHex(p.cssVars['text-dim'], p.cssVars.bg));
        const accentLc = Math.abs(apcaHex(p.cssVars['accent-active'], p.cssVars['bg-surface']));

        assert.ok(textLc >= 75, `text |Lc|=${textLc.toFixed(1)} < 75`);
        assert.ok(mutedLc >= 55, `muted |Lc|=${mutedLc.toFixed(1)} < 55`);
        assert.ok(dimLc >= 40, `dim |Lc|=${dimLc.toFixed(1)} < 40`);
        assert.ok(accentLc >= 45, `accent |Lc|=${accentLc.toFixed(1)} < 45`);
      });
    }
  }
});

describe('generatePalette: ANSI colors are canonically-hued', () => {
  // The whole point of canonical snapping: red stays red, green stays
  // green, regardless of anchor. If a future refactor accidentally
  // couples ANSI to anchor hue, this test catches it.
  it('red is red-ish even with a teal anchor', () => {
    const p = generatePalette('#5b8b8b', 'dark'); // teal anchor
    const [, , H] = hexToOklch(p.xterm.red);
    // Red should be in roughly [15, 40]°
    assert.ok(H >= 15 && H <= 40, `red H=${H.toFixed(1)} out of red range`);
  });

  it('green is green-ish even with a magenta anchor', () => {
    const p = generatePalette('#e91e63', 'dark'); // magenta anchor
    const [, , H] = hexToOklch(p.xterm.green);
    assert.ok(H >= 130 && H <= 160, `green H=${H.toFixed(1)} out of green range`);
  });

  it('blue is blue-ish even with an orange anchor', () => {
    const p = generatePalette('#ff6b35', 'dark');
    const [, , H] = hexToOklch(p.xterm.blue);
    assert.ok(H >= 240 && H <= 275, `blue H=${H.toFixed(1)} out of blue range`);
  });

  it('bright variants are lighter than their non-bright counterparts in dark mode', () => {
    const p = generatePalette('#cba6f7', 'dark');
    const pairs = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
    for (const c of pairs) {
      const normalL = hexToOklch(p.xterm[c])[0];
      const brightL = hexToOklch(p.xterm[`bright${c[0].toUpperCase()}${c.slice(1)}`])[0];
      assert.ok(brightL > normalL, `bright${c} should be lighter than ${c}`);
    }
  });
});

describe('generatePalette: polarity differences', () => {
  it('dark and light produce different bg colors for the same anchor', () => {
    const dark = generatePalette('#cba6f7', 'dark');
    const light = generatePalette('#cba6f7', 'light');
    assert.notEqual(dark.cssVars.bg, light.cssVars.bg);
  });

  it('light-mode bg is lighter than dark-mode bg', () => {
    const dark = generatePalette('#cba6f7', 'dark');
    const light = generatePalette('#cba6f7', 'light');
    const darkL = hexToOklch(dark.cssVars.bg)[0];
    const lightL = hexToOklch(light.cssVars.bg)[0];
    assert.ok(lightL > darkL);
  });

  it('light-mode bg-surface is pure white for the default anchor', () => {
    const light = generatePalette('#cba6f7', 'light');
    assert.equal(light.cssVars['bg-surface'], '#ffffff');
  });

  it('dark-mode bg-surface is darker than its text', () => {
    const dark = generatePalette('#cba6f7', 'dark');
    const bgL = hexToOklch(dark.cssVars['bg-surface'])[0];
    const textL = hexToOklch(dark.cssVars.text)[0];
    assert.ok(textL > bgL);
  });
});

describe('generatePalette: determinism', () => {
  it('same anchor + polarity produces identical output', () => {
    const p1 = generatePalette('#cba6f7', 'dark');
    const p2 = generatePalette('#cba6f7', 'dark');
    assert.deepEqual(p1.cssVars, p2.cssVars);
    assert.deepEqual(p1.xterm, p2.xterm);
  });
});

// ── Vibrancy: subtle vs colorful ────────────────────────────────────────

describe('generatePalette: vibrancy parameter', () => {
  it('defaults to "subtle" when omitted (back-compat)', () => {
    const def = generatePalette('#cba6f7', 'dark');
    const explicit = generatePalette('#cba6f7', 'dark', 'subtle');
    assert.deepEqual(def.cssVars, explicit.cssVars);
    assert.equal(def.vibrancy, 'subtle');
  });

  it('returns vibrancy in the result object', () => {
    const p = generatePalette('#cba6f7', 'dark', 'colorful');
    assert.equal(p.vibrancy, 'colorful');
  });

  it('rejects invalid vibrancy', () => {
    assert.throws(() => generatePalette('#cba6f7', 'dark', 'neon'));
  });

  it('colorful bg has visibly higher chroma than subtle bg', () => {
    // The whole point of "colorful" — backgrounds pick up more of the
    // tint hue. We measure C in OKLCH space; colorful must be at least
    // 2× subtle (the actual ratio in the ramp is ~4×).
    const subtle = generatePalette('#cba6f7', 'dark', 'subtle');
    const colorful = generatePalette('#cba6f7', 'dark', 'colorful');
    const subtleC = hexToOklch(subtle.cssVars.bg)[1];
    const colorfulC = hexToOklch(colorful.cssVars.bg)[1];
    assert.ok(colorfulC > subtleC * 2,
      `expected colorful bg C (${colorfulC.toFixed(4)}) > 2× subtle bg C (${subtleC.toFixed(4)})`);
  });

  it('colorful Cmin floor produces visible chroma for desaturated tints', () => {
    // Without the Cmin floor, multiplying a low anchor C by Cmul yields
    // an essentially neutral bg — the colorful toggle would look broken
    // for users who pick a near-grey tint. Cmin guarantees a minimum
    // visual chroma so the difference vs subtle is always perceptible.
    //
    // Pure grey (#808080) is an edge case: it has no hue to amplify, and
    // OKLCH gamut-clipping keeps any post-floor chroma below ~0.04 at
    // dark L. Tints with even a slight hue (mauve, peach, near-black blue)
    // comfortably exceed the floor.
    const tinted = ['#cba6f7', '#fff0ee', '#111122'];
    for (const tint of tinted) {
      const colorful = generatePalette(tint, 'dark', 'colorful');
      const bgC = hexToOklch(colorful.cssVars.bg)[1];
      assert.ok(bgC >= 0.045,
        `tint ${tint} colorful bg C=${bgC.toFixed(4)} below visible threshold 0.045`);
    }
  });

  it('colorful text has visibly higher chroma than subtle text', () => {
    const subtle = generatePalette('#cba6f7', 'dark', 'subtle');
    const colorful = generatePalette('#cba6f7', 'dark', 'colorful');
    const subtleC = hexToOklch(subtle.cssVars.text)[1];
    const colorfulC = hexToOklch(colorful.cssVars.text)[1];
    assert.ok(colorfulC > subtleC,
      `expected colorful text C (${colorfulC.toFixed(4)}) > subtle text C (${subtleC.toFixed(4)})`);
  });

  it('colorful ANSI red is more saturated than subtle ANSI red', () => {
    const subtle = generatePalette('#cba6f7', 'dark', 'subtle');
    const colorful = generatePalette('#cba6f7', 'dark', 'colorful');
    const subtleC = hexToOklch(subtle.xterm.red)[1];
    const colorfulC = hexToOklch(colorful.xterm.red)[1];
    assert.ok(colorfulC > subtleC,
      `expected colorful red C (${colorfulC.toFixed(4)}) > subtle red C (${subtleC.toFixed(4)})`);
  });
});

describe('generatePalette: colorful keeps canonical ANSI hues', () => {
  // Vibrancy must NOT rotate the ANSI hues — red still red, green still
  // green, regardless of how saturated colorful makes them.
  it('colorful red stays in red hue range with a teal tint', () => {
    const p = generatePalette('#5b8b8b', 'dark', 'colorful');
    const [, , H] = hexToOklch(p.xterm.red);
    assert.ok(H >= 15 && H <= 40, `red H=${H.toFixed(1)} out of red range`);
  });

  it('colorful green stays in green hue range with a magenta tint', () => {
    const p = generatePalette('#e91e63', 'dark', 'colorful');
    const [, , H] = hexToOklch(p.xterm.green);
    assert.ok(H >= 130 && H <= 160, `green H=${H.toFixed(1)} out of green range`);
  });
});

describe('generatePalette: colorful contrast guarantees', () => {
  // Colorful pushes chroma hard, but APCA still has to pass — that's the
  // headline guarantee. Same anchor list as subtle, both polarities.
  const anchors = [
    '#cba6f7', '#8839ef', '#5b8b8b', '#ff6b35', '#40a02b',
    '#1e66f5', '#d20f39', '#111122', '#fff0ee', '#808080',
  ];

  for (const anchor of anchors) {
    for (const polarity of ['dark', 'light']) {
      it(`${anchor} ${polarity} colorful passes contrast thresholds`, () => {
        const p = generatePalette(anchor, polarity, 'colorful');
        const textLc = Math.abs(apcaHex(p.cssVars.text, p.cssVars.bg));
        const mutedLc = Math.abs(apcaHex(p.cssVars['text-muted'], p.cssVars.bg));
        const dimLc = Math.abs(apcaHex(p.cssVars['text-dim'], p.cssVars.bg));
        const accentLc = Math.abs(apcaHex(p.cssVars['accent-active'], p.cssVars['bg-surface']));

        assert.ok(textLc >= 75, `text |Lc|=${textLc.toFixed(1)} < 75`);
        assert.ok(mutedLc >= 55, `muted |Lc|=${mutedLc.toFixed(1)} < 55`);
        assert.ok(dimLc >= 40, `dim |Lc|=${dimLc.toFixed(1)} < 40`);
        assert.ok(accentLc >= 45, `accent |Lc|=${accentLc.toFixed(1)} < 45`);
      });
    }
  }
});
