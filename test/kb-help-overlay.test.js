import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Tripwire test: the keyboard help overlay in public/index.html must
 * stay in sync with the actual shortcut spec.
 *
 * This used to drift — for months the overlay said "Clear terminal: Cmd+K"
 * while the handler bound it to Option+K, and "Word back: Option+←" while
 * the same handler bound Option+← to start-of-line. Users found shortcuts
 * that didn't work. This test prevents that class of bug from coming back.
 *
 * If you're changing the spec, update SPEC below AND the overlay AND
 * test/keyboard-spec.test.js. All three must agree.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, "..", "public", "index.html"), "utf-8");

// Canonical list. Order doesn't matter; presence does.
// Each entry: [human label, kbd glyphs in order]
//   ⌥ = Option
//   ⌘ = Cmd
//   ⌫ = Backspace
const SPEC = [
  ["New terminal",            ["⌥", "T"]],
  ["Close terminal",          ["⌥", "W"]],
  ["Kill session",            ["⌥", "Shift", "W"]],
  ["Rename tab",              ["⌥", "R"]],
  ["Previous tab",            ["⌥", "["]],
  ["Next tab",                ["⌥", "]"]],
  ["Jump to tab 1–9",         ["⌥", "1", "9"]],
  ["Jump to tab 10",          ["⌥", "0"]],
  ["Move tab left",           ["⌥", "{"]],
  ["Move tab right",          ["⌥", "}"]],
  ["Clear terminal",          ["⌥", "K"]],
  ["Search",                  ["⌥", "F"]],
  ["Command palette",         ["⌥", "Space"]],
  ["Start of line",           ["⌥", "←"]],
  ["End of line",             ["⌥", "→"]],
  ["Delete line",             ["⌥", "⌫"]],
  ["Literal newline",         ["Shift", "Enter"]],
  ["Indent / shell completion", ["Tab"]],
  ["Reverse indent",          ["Shift", "Tab"]],
  ["Interrupt (SIGINT)",      ["Ctrl", "C"]],
  ["This help",               ["⌘", "/"]],
];

// HTML uses entity codes. Map them to the glyphs the spec uses.
function decodeEntities(s) {
  return s
    .replace(/&#x2325;/g, "⌥")
    .replace(/&#8984;/g, "⌘")
    .replace(/&#8997;/g, "⌥") // alternative option entity, just in case
    .replace(/&amp;/g, "&");
}

function extractKbHelpList(html) {
  const m = html.match(/<ul class="kb-help-list">([\s\S]*?)<\/ul>/);
  assert.ok(m, "Could not find <ul class=\"kb-help-list\"> in index.html");
  const body = m[1];

  const items = [];
  const itemRe = /<li>\s*<span class="kb-label">([^<]+)<\/span>\s*<span>([\s\S]*?)<\/span>\s*<\/li>/g;
  let item;
  while ((item = itemRe.exec(body)) !== null) {
    const label = decodeEntities(item[1].replace(/&ndash;|–/g, "–")).trim();
    const keysHtml = item[2];
    const keys = [];
    const kbdRe = /<kbd>([^<]+)<\/kbd>/g;
    let kbd;
    while ((kbd = kbdRe.exec(keysHtml)) !== null) {
      keys.push(decodeEntities(kbd[1]).trim());
    }
    items.push([label, keys]);
  }
  return items;
}

describe("kb-help overlay", () => {
  const items = extractKbHelpList(indexHtml);

  it("contains every entry in the spec, in order, with matching keys", () => {
    assert.equal(items.length, SPEC.length,
      `kb-help overlay has ${items.length} entries, spec has ${SPEC.length}. ` +
      `If you added or removed a shortcut, update both the overlay and the SPEC ` +
      `array in test/kb-help-overlay.test.js.`);

    for (let i = 0; i < SPEC.length; i++) {
      const [expectedLabel, expectedKeys] = SPEC[i];
      const [actualLabel, actualKeys] = items[i];
      assert.equal(actualLabel, expectedLabel,
        `Entry ${i}: expected label "${expectedLabel}", got "${actualLabel}"`);
      assert.deepEqual(actualKeys, expectedKeys,
        `Entry "${expectedLabel}": expected keys ${JSON.stringify(expectedKeys)}, ` +
        `got ${JSON.stringify(actualKeys)}`);
    }
  });

  it("has no Cmd-prefixed entries that should be Option (regression)", () => {
    // The original bug: overlay said "Cmd+K" / "Cmd+F" / "Cmd+←" / "Cmd+→"
    // but the handler bound them to Option. Make sure those exact strings
    // never come back.
    for (const [label, keys] of items) {
      if (label === "Clear terminal" || label === "Search" ||
          label === "Start of line" || label === "End of line") {
        assert.notEqual(keys[0], "⌘",
          `"${label}" must use ⌥ (Option), not ⌘ (Cmd) — see PR history for the bug`);
      }
    }
  });

  it("does not document word-back / word-forward (removed from spec)", () => {
    for (const [label] of items) {
      assert.notEqual(label, "Word back",
        "Word back was removed from the spec — its handler was unreachable");
      assert.notEqual(label, "Word forward",
        "Word forward was removed from the spec — its handler was unreachable");
    }
  });
});
