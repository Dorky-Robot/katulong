/**
 * Screen Fingerprint — drift detection hash.
 *
 * DJB2 hash of cursor position + visible screen row content.
 * Runs identically on both server (headless xterm) and client (browser xterm)
 * so both sides produce the same hash for the same terminal state.
 *
 * Keep in sync with: lib/session.js screenFingerprint()
 */

export function screenFingerprint(terminal) {
  const buf = terminal.buffer.active;
  let h = 5381;
  h = ((h << 5) + h + buf.cursorY) | 0;
  h = ((h << 5) + h + buf.cursorX) | 0;
  for (let y = 0; y < terminal.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    if (!line) continue;
    const text = line.translateToString(true);
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
  }
  return h;
}
