/**
 * Replay an ordered sequence of text + image tokens into a tmux session,
 * as if a human were typing and pasting into the pane.
 *
 * Used by the `/paste` route to back two flavors of paste:
 *
 *   - Legacy image-only paste (xterm clipboard bridge): tokens are all
 *     `{ type: "image", path }` — for each, set clipboard, bridge to
 *     containers, write Ctrl+V to the pane.
 *
 *   - Interleaved text + image paste (feed tile reply): tokens alternate
 *     text chunks and image references in the order the user entered
 *     them, optionally followed by a real Enter (`submit: true`).
 *
 * Process-wide serialization: every call runs on a single promise chain
 * so two concurrent requests never race on the host clipboard (a global
 * resource) and two text replays into the same session never interleave
 * bytes. The serial latency is well inside human-paced use (one paste
 * per reply) and matches the "behaves like a person at a keyboard"
 * intent. `\x16` is written only after the clipboard set succeeds on
 * either the host or a bridged container — otherwise Claude Code would
 * read stale clipboard content.
 *
 * No I/O outside injected callbacks and a scoped existsSync. Accepts
 * the file-system primitives (setClipboard, bridge*) as deps so the
 * route handler and the unit tests can share one implementation.
 */

import { join, extname, basename, sep } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_PASTE_DELAY_MS = 50;
const PASTE_BYTE = "\x16"; // Ctrl+V — triggers Claude Code's paste handler

// Single process-wide serialization point. Both /paste and
// /api/claude/respond/:uuid feed into this, which also guards against
// two in-flight replays clobbering each other's clipboard state.
let replayChain = Promise.resolve();

/**
 * @param {object} opts
 * @param {Array<{type: "text", value: string} | {type: "image", path: string}>} opts.tokens
 * @param {object} [opts.session]             Live Session — must have .alive + .write().
 *                                             If absent, the host clipboard is
 *                                             still set for image tokens
 *                                             (legacy drag-drop), but \x16 /
 *                                             text writes / submit are skipped.
 * @param {string} [opts.sessionName]         Used for container-bridge targeting.
 * @param {object} [opts.sessionManager]      For bridgePaneContainer.
 * @param {string} opts.uploadsDir            Root dir for image paths (scope guard).
 * @param {boolean} [opts.submit]             Append real Enter (\r) at the end.
 * @param {function} opts.setClipboard        (filePath, ext, logger) => Promise<boolean>
 * @param {function} opts.bridgeClipboardToContainers (filename, mimeType, logger) => Promise<boolean>
 * @param {function} opts.bridgePaneContainer         (sessionName, sessionManager, filePath, mimeType, logger) => Promise<boolean>
 * @param {function} opts.imageMimeType       (ext) => string
 * @param {object} [opts.logger]              { warn, info }
 * @param {function} [opts.sleep]             (ms) => Promise — injectable for tests.
 * @param {function} [opts.onImagePasted]     (path) => void — fired only after a
 *                                             successful clipboard set, per
 *                                             image, so WS consumers don't see
 *                                             false-success signals.
 * @param {number} [opts.pasteDelayMs]        Settle delay after each image.
 * @returns {Promise<{pasted: number, aborted: boolean}>}
 */
export async function replayPasteSequence(opts) {
  const task = () => runReplayPasteSequence(opts);
  const next = replayChain.then(task, task);
  // Swallow rejections so one bad replay doesn't poison the chain; the
  // caller still observes the error via the returned promise.
  replayChain = next.catch(() => {});
  return next;
}

async function runReplayPasteSequence(opts) {
  const {
    tokens,
    session,
    sessionName,
    sessionManager,
    uploadsDir,
    submit = false,
    setClipboard,
    bridgeClipboardToContainers,
    bridgePaneContainer,
    imageMimeType,
    logger = { warn: () => {}, info: () => {} },
    sleep = defaultSleep,
    onImagePasted,
    pasteDelayMs = DEFAULT_PASTE_DELAY_MS,
  } = opts;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { pasted: 0, aborted: false };
  }

  const canWrite = Boolean(session && typeof session.write === "function");
  let pasted = 0;
  // Tracks whether the session died at any point during the replay, so
  // that the final return value accurately describes whether the caller
  // should treat the reply as lost (even if we happened to be on the
  // last token when it died).
  let sessionDied = false;

  for (const token of tokens) {
    if (canWrite && !session.alive) { sessionDied = true; break; }

    if (token?.type === "text") {
      if (canWrite && typeof token.value === "string" && token.value.length > 0) {
        session.write(token.value);
      }
      continue;
    }

    if (token?.type !== "image" || typeof token.path !== "string") continue;

    // Scope the path under uploadsDir to prevent traversal. Trailing
    // separator on the prefix check guards against a sibling directory
    // like `<uploadsDir>-evil` passing the prefix match, and the
    // !==-uploadsDir check rejects bare `/uploads/` that would resolve
    // to the uploads root itself.
    const filePath = join(uploadsDir, token.path.replace(/^\/uploads\//, ""));
    if (
      filePath === uploadsDir ||
      !filePath.startsWith(uploadsDir + sep) ||
      !existsSync(filePath)
    ) {
      logger.warn("replayPasteSequence: image path out of scope or missing", { path: token.path });
      continue;
    }

    const ext = extname(filePath).slice(1);
    const filename = basename(filePath);
    const mimeType = imageMimeType(ext);

    let clipboardOk = await setClipboard(filePath, ext, logger);
    const bridged = await bridgeClipboardToContainers(filename, mimeType, logger);
    if (bridged) clipboardOk = true;
    if (!bridged && sessionName) {
      const paneBridged = await bridgePaneContainer(sessionName, sessionManager, filePath, mimeType, logger);
      if (paneBridged) clipboardOk = true;
    }

    // Re-check session.alive after the clipboard/bridge awaits — it
    // could have died in that window. Without this the final return
    // would claim aborted:false even though the write was skipped.
    if (canWrite && !session.alive) { sessionDied = true; break; }

    if (clipboardOk) {
      if (canWrite) {
        session.write(PASTE_BYTE);
        pasted++;
      }
      if (typeof onImagePasted === "function") onImagePasted(token.path);
    }
    // If the clipboard did NOT get set, don't fire onImagePasted —
    // matches the pre-refactor behavior where the WS `paste-complete`
    // message only went out on success.

    await sleep(pasteDelayMs);
  }

  if (!sessionDied && submit && canWrite && session.alive) {
    session.write("\r");
  }

  return { pasted, aborted: sessionDied };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
