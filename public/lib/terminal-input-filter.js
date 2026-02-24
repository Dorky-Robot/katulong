/**
 * Terminal Input Filter
 *
 * Prevents terminal query responses from leaking back to the PTY as garbage
 * text. Uses two layers:
 *
 * 1. Parser hooks — intercept OSC color queries (10/11/12) at the xterm.js
 *    parser level before a response is ever generated.
 *
 * 2. onData filter — catch-all for any remaining terminal responses (cursor
 *    position reports, device attributes, focus reports) that xterm.js emits
 *    through onData.
 */

// --- OSC IDs whose query responses should be suppressed ---
// 10 = foreground color, 11 = background color, 12 = cursor color
const SUPPRESSED_OSC_IDS = [10, 11, 12];

/**
 * Register parser hooks that swallow OSC color query responses.
 * Call this once after creating the Terminal instance.
 *
 * Returns an array of IDisposable objects (call .dispose() to unregister).
 */
export function registerResponseSuppressors(term) {
  return SUPPRESSED_OSC_IDS.map(id =>
    term.parser.registerOscHandler(id, () => true)
  );
}

// --- Regex patterns for responses that bypass parser hooks ---

// Focus-reporting sequences (CSI I / CSI O)
const FOCUS_IN = /\x1b\[I/g;
const FOCUS_OUT = /\x1b\[O/g;

// Cursor Position Report (CPR): ESC [ row ; col R
const CPR_RESPONSE = /\x1b\[\d+;\d+R/g;

// Device Attributes: ESC [ ? params c  or  ESC [ > params c  or  ESC [ params c
const DA_RESPONSE = /\x1b\[[?>]?[\d;]*c/g;

/**
 * Filter remaining terminal query responses from onData input.
 * Returns the input with all terminal responses stripped.
 */
export function filterTerminalResponses(data) {
  return data
    .replace(FOCUS_IN, "")
    .replace(FOCUS_OUT, "")
    .replace(CPR_RESPONSE, "")
    .replace(DA_RESPONSE, "");
}
