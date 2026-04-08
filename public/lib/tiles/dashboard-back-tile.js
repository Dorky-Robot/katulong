/**
 * Dashboard Back-Tile
 *
 * Back-face tile for terminal cards. Shows agent status, run duration,
 * task assignment, process info, quick actions, and a compact event
 * timeline. Designed to be mounted via carousel.setBackTile().
 *
 * Usage:
 *   const back = createDashboardBackTile({ sessionName: "katulong--dev" });
 *   carousel.setBackTile(tileId, back);
 */

import { api } from "../api-client.js";

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
 * @param {string} options.sessionName — primary session name
 */
export function createDashboardBackTile({ sessionName } = {}) {
  // Mutable: kept in sync with the carousel's tile ID via setSessionName().
  // The carousel calls this from renameCard() so polling, action APIs,
  // and rendering all use the current name after a tab rename.
  let currentSessionName = sessionName;
  let container = null;
  let ctx = null;
  let rootEl = null;
  let pollTimer = null;
  let durationTimer = null;
  let startTime = Date.now();
  let destroyed = false;

  // State
  let currentStatus = "idle";    // "active" | "idle" | "exited"
  let childCount = 0;
  let hasChildProcesses = false;
  let prevHasChildProcesses = false;
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
    prevHasChildProcesses = hasChildProcesses;
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
          await api.delete(`/sessions/${encodeURIComponent(currentSessionName)}`);
          addEvent(`Killed session ${currentSessionName}`);
          updateStatus("exited");
        } catch (err) {
          addEvent(`Kill failed: ${err.message}`);
        }
        break;

      case "restart":
        try {
          await api.delete(`/sessions/${encodeURIComponent(currentSessionName)}`);
          addEvent(`Killed session ${currentSessionName}`);
          // Brief delay then recreate
          setTimeout(async () => {
            try {
              await api.post("/sessions", { name: currentSessionName });
              addEvent(`Restarted session ${currentSessionName}`);
              startTime = Date.now();
              updateStatus("idle");
            } catch (err) {
              addEvent(`Restart create failed: ${err.message}`);
            }
          }, 500);
        } catch (err) {
          addEvent(`Restart kill failed: ${err.message}`);
        }
        break;

      case "view-logs":
        // Flip back to the terminal front face
        if (ctx?.flip) ctx.flip();
        break;

      case "copy-output":
        try {
          const data = await api.get(`/sessions/${encodeURIComponent(currentSessionName)}/buffer?lines=50`);
          const text = Array.isArray(data) ? data.join("\n") : (data.output || data.buffer || "");
          await navigator.clipboard.writeText(text);
          addEvent("Copied last 50 lines to clipboard");
        } catch (err) {
          addEvent(`Copy failed: ${err.message}`);
        }
        break;
    }
  }

  // ── Polling ────────────────────────────────────────────────────────

  async function pollStatus() {
    if (destroyed) return;
    try {
      const status = await api.get(`/sessions/${encodeURIComponent(currentSessionName)}/status`);
      updateProcessInfo(status);

      // Detect transition: had child processes -> no child processes
      if (prevHasChildProcesses && !hasChildProcesses) {
        addEvent("Child processes exited");
      }
    } catch {
      // Session may not exist yet or network error — ignore
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollStatus(); // immediate first poll
    pollTimer = setInterval(pollStatus, 5000);
    durationTimer = setInterval(updateDuration, 1000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
  }

  // ── Tile prototype ─────────────────────────────────────────────────

  return {
    type: "dashboard-back",

    /** Update the session name after a tab rename. Mirrors terminal-tile's
     *  setSessionName so the dashboard's polling and actions stay aligned
     *  with the carousel key. */
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
      startPolling();
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
      stopPolling();
      rootEl?.remove();
      rootEl = null;
      container = null;
      ctx = null;
    },

    focus() {
      // Resume polling when visible
      startPolling();
    },

    blur() {
      // Pause polling when hidden
      stopPolling();
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
