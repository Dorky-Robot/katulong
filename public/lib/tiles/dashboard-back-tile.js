/**
 * Dashboard Back-Tile
 *
 * Back-face tile for terminal cards. Shows agent status, run duration,
 * task assignment, process info, quick actions, and a compact event
 * timeline. Mounted as the secondary face via ctx.faceStack.setSecondary()
 * from terminal-tile.js. (Pre-Tier-1 it was mounted via
 * carousel.setBackTile — that API no longer exists on the public
 * carousel surface; the container exposes `ctx.faceStack` instead.)
 */

import { api, invalidateSessionIdCache } from "../api-client.js";

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function statusClass(status) {
  if (status === "active") return "status-active";
  if (status === "idle") return "status-idle";
  return "status-exited";
}

function statusLabel(status) {
  if (status === "active") return "active";
  if (status === "idle") return "idle";
  return "exited";
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string} options.sessionName — primary session name (for display)
 * @param {string} options.sessionId — stable session id (used for API calls)
 * @param {object} [options.watcher] — optional shared SessionStatusWatcher.
 *   Terminal tile passes its watcher in so the front and back faces share
 *   a single poller instead of running duplicate intervals. When omitted
 *   (e.g. in tests that render the back tile in isolation) the back tile
 *   is inert — no polling, no status updates beyond what's set manually.
 */
export function createDashboardBackTile({ sessionName, sessionId, watcher } = {}) {
  // Mutable display name (updated on rename via setSessionName). API calls
  // route through `sessionId`, which is stable for the life of the session
  // and does NOT change on rename.
  let currentSessionName = sessionName;
  let container = null;
  let ctx = null;
  let rootEl = null;
  let durationTimer = null;
  let startTime = Date.now();
  let destroyed = false;
  let watcherUnsubscribe = null;

  // State
  let currentStatus = "idle";    // "active" | "idle" | "exited"
  let childCount = 0;
  let hasChildProcesses = false;
  const events = [];             // { time: Date, text: string }[]

  function addEvent(text) {
    events.push({ time: new Date(), text });
    if (events.length > 10) events.shift();
    renderTimeline();
  }

  // ── DOM builders ───────────────────────────────────────────────────

  function buildTerminalView() {
    return `
      <div class="dashboard-back">
        <div class="db-header">
          <div class="db-session-name">${escapeHtml(currentSessionName)}</div>
          <span class="status-badge ${statusClass(currentStatus)}">${statusLabel(currentStatus)}</span>
          <span class="duration" data-role="duration">${formatDuration(Date.now() - startTime)}</span>
        </div>

        <div class="db-section db-task-section">
          <div class="db-section-label">Task</div>
          <div class="db-task-content" data-role="task">No task assigned</div>
        </div>

        <div class="db-section db-process-section">
          <div class="db-section-label">Process</div>
          <div class="db-process-info" data-role="process">
            <span class="db-process-item">
              <i class="ph ph-tree-structure"></i>
              <span data-role="child-count">${childCount}</span> child processes
            </span>
            <span class="db-process-item">
              <i class="ph ph-robot"></i>
              <span data-role="claude-running">${hasChildProcesses ? "Claude Code running" : "No agent"}</span>
            </span>
          </div>
        </div>

        <div class="db-section db-actions">
          <button class="action-btn action-btn-danger" data-action="kill">
            <i class="ph ph-x-circle"></i> Kill
          </button>
          <button class="action-btn" data-action="restart">
            <i class="ph ph-arrow-clockwise"></i> Restart
          </button>
          <button class="action-btn" data-action="view-logs">
            <i class="ph ph-terminal-window"></i> View logs
          </button>
          <button class="action-btn" data-action="copy-output">
            <i class="ph ph-copy"></i> Copy output
          </button>
        </div>

        <div class="db-section db-timeline-section">
          <div class="db-section-label">Timeline</div>
          <div class="db-timeline" data-role="timeline"></div>
        </div>
      </div>
    `;
  }

  // ── Render helpers ─────────────────────────────────────────────────

  function render() {
    if (!rootEl) return;
    rootEl.innerHTML = buildTerminalView();
    wireActions();
    renderTimeline();
  }

  function renderTimeline() {
    const timelineEl = rootEl?.querySelector('[data-role="timeline"]');
    if (!timelineEl) return;
    if (events.length === 0) {
      timelineEl.innerHTML = '<div class="db-timeline-empty">No events yet</div>';
      return;
    }
    timelineEl.innerHTML = events.map(e => {
      const t = e.time;
      const ts = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
      return `<div class="db-timeline-event"><span class="db-timeline-ts">${ts}</span> ${escapeHtml(e.text)}</div>`;
    }).join("");
    // Auto-scroll to latest
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  function updateDuration() {
    const el = rootEl?.querySelector('[data-role="duration"]');
    if (el) el.textContent = formatDuration(Date.now() - startTime);
  }

  function updateStatus(status) {
    if (status === currentStatus) return;
    currentStatus = status;
    const badge = rootEl?.querySelector(".status-badge");
    if (badge) {
      badge.className = `status-badge ${statusClass(status)}`;
      badge.textContent = statusLabel(status);
    }
  }

  function updateProcessInfo(info) {
    childCount = info.childCount || 0;
    hasChildProcesses = info.hasChildProcesses || false;

    const countEl = rootEl?.querySelector('[data-role="child-count"]');
    if (countEl) countEl.textContent = String(childCount);

    const claudeEl = rootEl?.querySelector('[data-role="claude-running"]');
    if (claudeEl) claudeEl.textContent = hasChildProcesses ? "Claude Code running" : "No agent";

    // Determine status
    if (!info.alive) {
      updateStatus("exited");
    } else if (hasChildProcesses) {
      updateStatus("active");
    } else {
      updateStatus("idle");
    }
  }

  // ── Actions ────────────────────────────────────────────────────────

  function wireActions() {
    if (!rootEl) return;
    rootEl.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleAction(btn.dataset.action);
      });
    });
  }

  async function handleAction(action) {
    switch (action) {
      case "kill":
        try {
          await api.delete(`/sessions/by-id/${encodeURIComponent(sessionId)}`);
          invalidateSessionIdCache(currentSessionName);
          addEvent(`Killed session ${currentSessionName}`);
          updateStatus("exited");
        } catch (err) {
          addEvent(`Kill failed: ${err.message}`);
        }
        break;

      case "restart":
        try {
          await api.delete(`/sessions/by-id/${encodeURIComponent(sessionId)}`);
          invalidateSessionIdCache(currentSessionName);
          if (destroyed) return;
          addEvent(`Killed session ${currentSessionName}`);
          // Brief delay then recreate. The destroyed guard must fire on
          // both the timer callback and after the await — the tile can
          // be unmounted during the 500ms delay, and any mutation of
          // startTime or state after that is a stale write.
          setTimeout(async () => {
            if (destroyed) return;
            try {
              await api.post("/sessions", { name: currentSessionName });
              invalidateSessionIdCache(currentSessionName);
              if (destroyed) return;
              addEvent(`Restarted session ${currentSessionName}`);
              startTime = Date.now();
              updateStatus("idle");
            } catch (err) {
              if (destroyed) return;
              addEvent(`Restart create failed: ${err.message}`);
            }
          }, 500);
        } catch (err) {
          if (destroyed) return;
          addEvent(`Restart kill failed: ${err.message}`);
        }
        break;

      case "view-logs":
        // Flip back to the terminal front face
        if (ctx?.flip) ctx.flip();
        break;

      case "copy-output":
        try {
          const data = await api.get(`/sessions/by-id/${encodeURIComponent(sessionId)}/output?lines=50`);
          const text = Array.isArray(data) ? data.join("\n") : (data.output || data.buffer || "");
          await navigator.clipboard.writeText(text);
          addEvent("Copied last 50 lines to clipboard");
        } catch (err) {
          addEvent(`Copy failed: ${err.message}`);
        }
        break;
    }
  }

  // ── Status subscription ────────────────────────────────────────────
  //
  // The terminal tile owns the SessionStatusWatcher for this session
  // and passes it to us at construction time. We subscribe instead of
  // running our own interval — one poller per session, not two racing.
  // The duration timer is still ours (local UI tick; no fetch).

  function handleStatusEvent(event) {
    if (destroyed) return;
    if (!event.status) return;
    updateProcessInfo(event.status);
    if (event.transitions?.idle) {
      addEvent("Child processes exited");
    }
  }

  function startSubscription() {
    if (watcher && !watcherUnsubscribe) {
      watcherUnsubscribe = watcher.subscribe(handleStatusEvent);
    }
    if (!durationTimer) {
      durationTimer = setInterval(updateDuration, 1000);
    }
  }

  function stopSubscription() {
    if (watcherUnsubscribe) { watcherUnsubscribe(); watcherUnsubscribe = null; }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
  }

  // ── Tile prototype ─────────────────────────────────────────────────

  return {
    type: "dashboard-back",

    /** Update the displayed session name after a tab rename. API calls
     *  route through the immutable sessionId, so this only refreshes
     *  display surfaces — the .db-session-name DOM node and the chrome
     *  toolbar title. */
    setSessionName(newName) {
      currentSessionName = newName;
      if (rootEl) {
        const nameEl = rootEl.querySelector(".db-session-name");
        if (nameEl) nameEl.textContent = newName;
      }
      if (ctx?.chrome?.toolbar) {
        ctx.chrome.toolbar.setTitle(newName);
      }
    },

    mount(el, tileCtx) {
      container = el;
      ctx = tileCtx;
      destroyed = false;

      rootEl = document.createElement("div");
      rootEl.className = "dashboard-back-root";
      el.appendChild(rootEl);

      render();
      startSubscription();
      addEvent("Dashboard opened");

      // Wire up toolbar
      if (ctx?.chrome?.toolbar) {
        ctx.chrome.toolbar.setTitle(currentSessionName);
        ctx.chrome.toolbar.addButton({
          icon: "arrow-u-up-left",
          label: "Back to terminal",
          position: "right",
          onClick: () => ctx.flip(),
        });
      }
    },

    unmount() {
      destroyed = true;
      stopSubscription();
      rootEl?.remove();
      rootEl = null;
      container = null;
      ctx = null;
    },

    focus() {
      // Resume subscription when visible
      startSubscription();
    },

    blur() {
      // Pause subscription when hidden — the terminal tile's watcher
      // keeps polling (terminal tile stays mounted under the flipped
      // card), so resuming on focus picks up the next tick.
      stopSubscription();
    },

    resize() {
      // No special resize needed — CSS handles layout
    },

    getTitle() {
      return `${currentSessionName} Dashboard`;
    },

    getIcon() {
      return "chart-bar";
    },

    /** Expose for auto-flip detection from terminal-tile */
    getStatus() {
      return currentStatus;
    },

    /** Expose for external event injection */
    addEvent,
  };
}
