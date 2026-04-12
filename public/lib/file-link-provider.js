/**
 * File Link Provider
 *
 * Custom xterm.js link provider that detects file paths in terminal output
 * and makes them clickable. Uses the same line-joining logic as the URL
 * link provider to handle wrapped lines from tmux redraws.
 *
 * Matched paths: relative (docs/file.md, ./lib/foo.js), absolute
 * (/Users/x/file.md), and bare filenames with known extensions
 * (README.md, server.js). Optional :line:col suffix (lib/foo.js:42).
 */

import {
  scanBackward,
  scanForward,
  offsetToCoord,
} from "/lib/wrapped-link-provider.js";

// Two patterns, combined with alternation:
//
// 1. Paths with "/" — any extension is fine since the slash is a strong
//    signal (docs/file.md, ./lib/foo.js, /absolute/path.txt).
//
// 2. Bare filenames — no "/" so we restrict to known extensions to avoid
//    matching random words (README.md, server.js, Makefile.toml).
//
// Both require whitespace (or start of string) before the match to
// exclude URL path segments. Optional :line:col suffix.
const KNOWN_EXT =
  "md|js|mjs|cjs|ts|tsx|jsx|json|yaml|yml|toml|xml|ini|cfg|conf|" +
  "sh|bash|zsh|fish|py|rb|rs|go|java|c|h|cpp|hpp|cs|swift|kt|" +
  "css|scss|less|html|htm|svg|sql|graphql|gql|proto|" +
  "txt|log|env|lock|csv|tsv|diff|patch";

const FILE_PATH_RE = new RegExp(
  "(?<!\\S)(?:" +
    // Pattern 1: paths with at least one "/"
    "(?:\\.{0,2}/)?(?:[\\w@._-]+/)+[\\w@._-]+\\.\\w{1,10}" +
    "|" +
    // Pattern 2: bare filenames with known extensions (lookahead
    // prevents partial matches like "package.js" from "package.json")
    "[\\w@._-]+\\.(?:" + KNOWN_EXT + ")(?!\\w)" +
  ")(?::\\d+(?::\\d+)?)?",        // optional :line:col
);

/**
 * Register the file link provider on a terminal instance.
 * Returns a disposable that removes the provider.
 *
 * @param {import('xterm').Terminal} terminal
 * @param {function} handler - (event, filePath) => void
 * @returns {{ dispose(): void }}
 */
export function registerFileLinkProvider(terminal, handler) {
  if (!handler) return { dispose() {} };
  return terminal.registerLinkProvider(
    new FileLinkProvider(terminal, handler),
  );
}

class FileLinkProvider {
  constructor(terminal, handler) {
    this._terminal = terminal;
    this._handler = handler;
  }

  provideLinks(lineNumber, callback) {
    const buf = this._terminal.buffer.active;
    const cols = this._terminal.cols;
    const y = lineNumber - 1;

    const startY = scanBackward(buf, y, cols);
    const endY = scanForward(buf, y, cols);

    const texts = [];
    for (let i = startY; i <= endY; i++) {
      const line = buf.getLine(i);
      texts.push(line ? line.translateToString(true) : "");
    }

    const joined = texts.join("");
    const re = new RegExp(FILE_PATH_RE.source, "gi");
    const links = [];
    let m;

    while ((m = re.exec(joined)) !== null) {
      const match = m[0];
      const start = offsetToCoord(texts, startY, m.index);
      const end = offsetToCoord(texts, startY, m.index + match.length - 1);
      if (!start || !end) continue;

      if (start.y > y || end.y < y) continue;

      // Strip :line:col suffix for the file path passed to handler
      const filePath = match.replace(/:\d+(?::\d+)?$/, "");

      links.push({
        range: {
          start: { x: start.x + 1, y: start.y + 1 },
          end: { x: end.x + 1, y: end.y + 1 },
        },
        text: match,
        activate: (_ev, text) => this._handler(_ev, filePath),
      });
    }

    callback(links.length ? links : undefined);
  }
}
