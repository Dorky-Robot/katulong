/**
 * Terminal tile status bar.
 *
 * A Warp-style pill strip docked at the bottom of every terminal tile.
 * Shows what the session is "in":
 *
 *   [📁 ~/Projects/…/katulong]  [🌿 main]  [katulong-git-info]  [🤖 claude]
 *
 * Data source: the `meta.pane` and `meta.agent` payloads the server stamps
 * from the 5s pane monitor (see `lib/session-child-counter.js`). The
 * terminal tile already polls `/sessions/by-id/:id/status` via a shared
 * watcher and `meta.pane` rides along on that response, so the status bar
 * subscribes to the same watcher — no extra poller.
 *
 * The bar is absolutely positioned over the xterm viewport. We accept
 * that it covers the bottom ~1 row of terminal output; keeping layout
 * flat avoids a structural refactor of the terminalPool container.
 */

import { escapeHtml } from "/lib/utils.js";

function shortenHome(path) {
  if (typeof path !== "string" || !path) return "";
  // macOS `/Users/<name>/...` and Linux `/home/<name>/...` → `~/...`.
  // Matching a single segment after /Users or /home avoids eating
  // project dirs that happen to live at /Users/shared or similar.
  return path.replace(/^(\/Users|\/home)\/[^/]+/, "~");
}

/**
 * Render a mid-path ellipsis when the shown path exceeds `maxLen`.
 * `~/Projects/dorky_robot/katulong-git-info/deep/nested` → `~/Projects/…/deep/nested`
 */
function compactPath(shown, maxLen = 48) {
  if (shown.length <= maxLen) return shown;
  const parts = shown.split("/");
  if (parts.length <= 3) return shown;
  // Keep first 2 segments and last 2, collapse the middle.
  const head = parts.slice(0, 2).join("/");
  const tail = parts.slice(-2).join("/");
  const candidate = `${head}/…/${tail}`;
  return candidate.length < shown.length ? candidate : shown;
}

export function createTerminalStatusBar() {
  let rootEl = null;
  let state = { pane: null, agent: null };

  function build() {
    rootEl = document.createElement("div");
    rootEl.className = "term-status-bar";
    rootEl.innerHTML = "";
    return rootEl;
  }

  function pill(iconClass, text, extraClass = "") {
    return `
      <span class="term-status-pill ${extraClass}">
        <i class="ph ${iconClass}"></i>
        <span class="term-status-pill-text">${escapeHtml(text)}</span>
      </span>
    `;
  }

  function render() {
    if (!rootEl) return;
    const { pane, agent } = state;
    const pills = [];

    const cwd = pane?.cwd;
    const git = pane?.git;

    if (cwd) {
      const shown = compactPath(shortenHome(cwd));
      pills.push(pill("ph-folder", shown, "term-status-folder"));
    }

    // Any git data → render the branch pill. `branch` is null on detached
    // HEAD, which we show as "detached" rather than hiding the pill.
    if (git) {
      pills.push(pill("ph-git-branch", git.branch ?? "detached", "term-status-branch"));
    }

    if (git?.worktree) {
      pills.push(`
        <span class="term-status-pill term-status-worktree">
          <span class="term-status-pill-text">${escapeHtml(git.worktree)}</span>
        </span>
      `);
    }

    if (agent?.running && agent.kind) {
      pills.push(pill("ph-robot", agent.kind, "term-status-agent"));
    }

    rootEl.innerHTML = pills.join("");
    rootEl.style.display = pills.length > 0 ? "" : "none";
  }

  return {
    mount(parentEl) {
      if (rootEl) return rootEl;
      build();
      // The bar is absolutely positioned; the parent must establish a
      // positioning context. Tile slots don't guarantee `position:
      // relative`, so set it defensively. Idempotent.
      const computed = getComputedStyle(parentEl).position;
      if (computed === "static") parentEl.style.position = "relative";
      parentEl.appendChild(rootEl);
      render();
      return rootEl;
    },

    unmount() {
      rootEl?.remove();
      rootEl = null;
    },

    /**
     * Accept a status event from SessionStatusWatcher. The `status` field
     * mirrors the server's /status payload, which now includes `pane` and
     * (when an agent is detected) `meta.agent`.
     */
    updateFromStatus(status) {
      if (!status) return;
      if (status.pane !== undefined) state.pane = status.pane;
      if (status.agent !== undefined) state.agent = status.agent;
      render();
    },

  };
}
