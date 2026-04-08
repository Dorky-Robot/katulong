/**
 * Named-key resolver for `katulong session send`.
 *
 * Maps human-readable key names (Enter, Tab, C-c, Up, F1, ...) to the raw
 * byte sequences a PTY expects. Lives in its own module so the CLI test
 * suite can exercise it without spawning a server.
 *
 * Why a static table and not termcap/terminfo: the consumer is the remote
 * shell on the *server* side of katulong, which already runs inside a
 * concrete terminal. We just need the canonical xterm-style sequences that
 * almost every modern shell understands. Keeping the table inline also
 * means `katulong session send` has zero runtime dependencies.
 */

/** @type {Record<string, string>} */
const STATIC_KEYS = {
  Enter: "\r",
  Return: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Esc: "\x1b",
  Backspace: "\x7f",
  Space: " ",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

/**
 * Resolve a named key to its raw byte sequence.
 * Throws an Error with a list of valid names on unknown input.
 *
 * @param {string} name
 * @returns {string}
 */
export const resolveKey = (name) => {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Key name must be a non-empty string");
  }
  if (Object.prototype.hasOwnProperty.call(STATIC_KEYS, name)) {
    return STATIC_KEYS[name];
  }
  // Control chars: C-a..C-z (case-insensitive on the letter)
  const ctrl = /^C-([a-zA-Z])$/.exec(name);
  if (ctrl) {
    const letter = ctrl[1].toLowerCase();
    return String.fromCharCode(letter.charCodeAt(0) - 96);
  }
  const valid = [...Object.keys(STATIC_KEYS), "C-a..C-z"].join(", ");
  throw new Error(`Unknown key name: "${name}". Valid keys: ${valid}`);
};

/**
 * Walk argv-style tokens for `katulong session send` and build the ordered
 * payload. Tokens are either positional text or `--key <NAME>` / `--enter`
 * pairs; their argv order determines concatenation order. The session name
 * is NOT included here — the caller strips it before invoking us.
 *
 * @param {string[]} tokens
 * @returns {{ payload: string, hadKey: boolean, hadText: boolean }}
 */
export const buildPayload = (tokens) => {
  let payload = "";
  let hadKey = false;
  let hadText = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--enter") {
      payload += resolveKey("Enter");
      hadKey = true;
      continue;
    }
    if (t === "--key") {
      const next = tokens[i + 1];
      if (next === undefined) throw new Error("--key requires a key name");
      payload += resolveKey(next);
      hadKey = true;
      i++;
      continue;
    }
    payload += t;
    hadText = true;
  }
  return { payload, hadKey, hadText };
};
