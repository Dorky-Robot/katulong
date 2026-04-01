/**
 * Crew Tile
 *
 * Displays a compact overview of multiple terminal sessions (a "crew").
 * Each session is shown as a mini status card. The back face shows an
 * aggregate dashboard with statuses and quick actions for all sessions.
 *
 * Usage:
 *   createTile("crew", {
 *     name: "dev-crew",
 *     sessions: ["worker-1", "worker-2", "worker-3"],
 *   })
 */

import { api } from "../api-client.js";
import { createDashboardBackTile } from "./dashboard-back-tile.js";

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

/**
 * Create the crew tile factory.
 *
 * @param {object} deps
 * @param {object} deps.carousel — carousel instance (for setBackTile)
 * @returns {(options: object) => TilePrototype}
 */
export function createCrewTileFactory(deps) {
  return function createCrewTile({ name = "Crew", sessions = [] } = {}) {
    let container = null;
    let ctx = null;
    let rootEl = null;
    let pollTimer = null;
    let backTile = null;
    const sessionStatuses = new Map();

    function statusClass(s) {
      if (s === "active") return "crew-status-active";
      if (s === "idle") return "crew-status-idle";
      return "crew-status-exited";
    }

    function renderGrid() {
      if (!rootEl) return;
      rootEl.innerHTML = sessions.map(sName => {
        const s = sessionStatuses.get(sName) || { status: "idle", childCount: 0 };
        return `
          <div class="crew-mini-card ${statusClass(s.status)}" data-session="${escapeHtml(sName)}">
            <div class="crew-mini-name">${escapeHtml(sName)}</div>
            <div class="crew-mini-status">
              <span class="crew-mini-badge">${s.status}</span>
              <span class="crew-mini-children">${s.childCount} <i class="ph ph-tree-structure"></i></span>
            </div>
          </div>
        `;
      }).join("") || '<div class="crew-empty">No sessions</div>';
    }

    async function pollAll() {
      for (const sName of sessions) {
        try {
          const status = await api.get(`/sessions/${encodeURIComponent(sName)}/status`);
          sessionStatuses.set(sName, {
            status: !status.alive ? "exited" : status.hasChildProcesses ? "active" : "idle",
            childCount: status.childCount || 0,
            hasChildProcesses: status.hasChildProcesses || false,
          });
        } catch {
          // Session may not exist
        }
      }
      renderGrid();
      // Also update back tile session data
      if (backTile?.setSessions) backTile.setSessions(sessions);
    }

    return {
      type: "crew",

      /** Crew name for identification. */
      name,

      /** Session names managed by this crew. */
      sessions,

      mount(el, tileCtx) {
        container = el;
        ctx = tileCtx;

        rootEl = document.createElement("div");
        rootEl.className = "crew-tile-grid";
        el.appendChild(rootEl);

        renderGrid();

        // Start polling session statuses
        pollAll();
        pollTimer = setInterval(pollAll, 5000);

        // ── Toolbar: flip button ───────────────────────────────────
        if (ctx?.chrome?.toolbar) {
          ctx.chrome.toolbar.setTitle(name);
          ctx.chrome.toolbar.addButton({
            icon: "chart-bar",
            label: "Crew dashboard",
            position: "right",
            onClick: () => ctx.flip(),
          });
        }

        // ── Register crew dashboard back-face ──────────────────────
        const carousel = deps?.carousel;
        const tileId = ctx?.tileId;
        if (carousel && tileId) {
          backTile = createDashboardBackTile({
            sessionName: name,
            mode: "crew",
            sessions,
          });
          carousel.setBackTile(tileId, backTile);
        }
      },

      unmount() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        rootEl?.remove();
        rootEl = null;
        container = null;
        ctx = null;
        backTile = null;
      },

      focus() {
        // Re-poll on focus
        pollAll();
      },

      blur() {},

      resize() {},

      getTitle() { return name; },
      getIcon() { return "users-three"; },

      serialize() {
        return { type: "crew", name, sessions };
      },

      /** Update the session list dynamically. */
      setSessions(newSessions) {
        sessions.length = 0;
        sessions.push(...newSessions);
        pollAll();
      },
    };
  };
}
