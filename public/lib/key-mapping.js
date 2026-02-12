/**
 * Key Mapping and Transformation
 *
 * Generic key sequence mapping and display utilities.
 */

/**
 * Convert single key combo to terminal sequence
 */
function singleComboToSequence(combo) {
  const parts = combo.toLowerCase().trim().split("+");
  const mods = new Set();
  let base = null;

  for (const p of parts) {
    if (["ctrl", "cmd", "alt", "shift"].includes(p)) mods.add(p);
    else base = p;
  }

  const named = {
    esc: "\x1b", tab: "\t", enter: "\r", space: " ",
    backspace: "\x7f", delete: "\x1b[3~",
    up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  };

  if (!base && mods.size > 0) return "";
  if (mods.has("ctrl") && base?.length === 1 && base >= "a" && base <= "z")
    return String.fromCharCode(base.charCodeAt(0) - 96);
  if (mods.has("ctrl")) { const m = { backspace: "\x08", space: "\x00" }; if (m[base]) return m[base]; }
  if (mods.has("cmd"))  { const m = { backspace: "\x15", left: "\x01", right: "\x05", k: "\x0b" }; if (m[base]) return m[base]; }
  if (mods.has("alt"))  {
    const m = { backspace: "\x1b\x7f", left: "\x1bb", right: "\x1bf" };
    if (m[base]) return m[base];
    if (base?.length === 1) return "\x1b" + base;
  }
  if (mods.has("shift") && base?.length === 1) return base.toUpperCase();
  if (named[base]) return named[base];
  if (base?.length === 1) return base;
  return combo;
}

/**
 * Convert keys string to sequence array
 */
export function keysToSequence(keys) {
  return keys.split(",").map(part => singleComboToSequence(part.trim()));
}

/**
 * Send key sequence with optional delays
 */
export function sendSequence(parts, sender) {
  if (typeof parts === "string") { sender(parts); return; }
  parts.forEach((p, i) => {
    if (i === 0) sender(p);
    else setTimeout(() => sender(p), i * 100);
  });
}

// --- Key transformation pipeline (composable) ---

/**
 * Composition helper
 */
const pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);

/**
 * Group keys by comma separator
 */
const groupKeysBySeparator = (keys) => {
  const groups = [];
  let current = [];
  for (const k of keys) {
    if (k === ",") {
      if (current.length > 0) groups.push(current);
      current = [];
    } else {
      current.push(k);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
};

/**
 * Transform groups with mapper function
 */
const mapGroups = (groupMapper) => (groups) => groups.map(groupMapper);

/**
 * Join groups with separators
 */
const joinGroups = (innerSep, outerSep) => (groups) =>
  groups.map(g => g.join(innerSep)).join(outerSep);

/**
 * Key display mapping
 */
const KEY_DISPLAY = {
  ctrl: "Ctrl", cmd: "Cmd", alt: "Alt", option: "Option", shift: "Shift",
  esc: "Esc", escape: "Esc", tab: "Tab", enter: "Enter", return: "Enter",
  space: "Space", backspace: "Bksp", delete: "Del",
  up: "Up", down: "Down", left: "Left", right: "Right",
};

export const displayKey = (k) => KEY_DISPLAY[k] || k.toUpperCase();

/**
 * Create human-readable label from keys
 */
export const keysLabel = pipe(
  groupKeysBySeparator,
  mapGroups(group => group.map(displayKey)),
  joinGroups("+", ", ")
);

/**
 * Create keys string for storage
 */
export const keysString = pipe(
  groupKeysBySeparator,
  joinGroups("+", ",")
);

/**
 * Valid key names
 */
export const VALID_KEYS = new Set([
  "ctrl", "cmd", "alt", "option", "shift",
  "esc", "escape", "tab", "enter", "return",
  "space", "backspace", "delete",
  "up", "down", "left", "right",
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),  // a-z
  ...Array.from({ length: 10 }, (_, i) => String(i)),  // 0-9
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),  // f1-f12
]);

/**
 * Normalize key name
 */
export const normalizeKey = (k) => {
  const n = k.toLowerCase().trim();
  return n === "option" ? "alt" : n === "return" ? "enter" : n === "escape" ? "esc" : n;
};
