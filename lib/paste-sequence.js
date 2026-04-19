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
 * Sequential per-session: the clipboard is a global resource (host +
 * container), so two images in flight would race. `\x16` is written only
 * after the clipboard set succeeds on either the host or a bridged
 * container — otherwise Claude Code would read stale clipboard content.
 *
 * No I/O outside injected callbacks. Accepts the file-system primitives
 * (setClipboard, bridge*) as deps so the route handler and the unit
 * tests can share one implementation.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_PASTE_DELAY_MS = 50;
const PASTE_BYTE = "\x16"; // Ctrl+V — triggers Claude Code's paste handler

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
 * @param {function} [opts.onImagePasted]     (path) => void — per-image progress callback (WS relay).
 * @param {number} [opts.pasteDelayMs]        Settle delay after each image.
 * @returns {Promise<{pasted: number, aborted: boolean}>}
 */
export async function replayPasteSequence(opts) {
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

  for (const t of tokens) {
    if (canWrite && !session.alive) return { pasted, aborted: true };

    if (t?.type === "text") {
      if (canWrite && typeof t.value === "string" && t.value.length > 0) {
        session.write(t.value);
      }
      continue;
    }

    if (t?.type !== "image" || typeof t.path !== "string") continue;

    // Scope the path under uploadsDir to prevent traversal.
    const filePath = join(uploadsDir, t.path.replace(/^\/uploads\//, ""));
    if (!filePath.startsWith(uploadsDir) || !existsSync(filePath)) {
      logger.warn("replayPasteSequence: image path out of scope or missing", { path: t.path });
      continue;
    }

    const ext = filePath.split(".").pop();
    const filename = filePath.split("/").pop();
    const mimeType = imageMimeType(ext);

    let clipboardOk = await setClipboard(filePath, ext, logger);
    const bridged = await bridgeClipboardToContainers(filename, mimeType, logger);
    if (bridged) clipboardOk = true;
    if (!bridged && sessionName) {
      const paneBridged = await bridgePaneContainer(sessionName, sessionManager, filePath, mimeType, logger);
      if (paneBridged) clipboardOk = true;
    }

    if (clipboardOk && canWrite && session.alive) {
      session.write(PASTE_BYTE);
      pasted++;
      if (typeof onImagePasted === "function") onImagePasted(t.path);
    } else if (typeof onImagePasted === "function") {
      // Even without a session, report the clipboard-set so WS consumers
      // get the same completion event they always got.
      onImagePasted(t.path);
    }

    await sleep(pasteDelayMs);
  }

  if (submit && canWrite && session.alive) {
    session.write("\r");
  }

  return { pasted, aborted: false };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
