/**
 * Crew Tile
 *
 * Shows a CSS grid of mini-terminals monitoring orchestrated worker sessions
 * for a project. Each mini-terminal is an independent xterm.js instance
 * (NOT from the shared pool) subscribed to session output via the pub/sub
 * SSE endpoint. Tapping a mini-terminal promotes it to a full terminal tile.
 *
 * Usage:
 *   createTile("crew", {
 *     project: "katulong",
 *     sessions: ["katulong--dev", "katulong--test", "katulong--perf"],
 *     title: "katulong crew",    // optional
 *   })
 */

import { Terminal } from "/vendor/xterm/xterm.esm.js";
import { WebglAddon } from "/vendor/xterm/addon-webgl.esm.js";
import { api } from "/lib/api-client.js";
import { basePath } from "/lib/base-path.js";
import { TERMINAL_COLS } from "/lib/terminal-config.js";

/**
 * Load WebGL renderer with automatic fallback to DOM on failure.
 * Same pattern as terminal-pool.js but for standalone instances.
 */
function loadWebGL(term) {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch {
    // WebGL2 not available — DOM renderer stays active
  }
}

/**
 * Measure char width ratio for the terminal's font family.
 * Duplicated from terminal-pool.js since that module doesn't export it.
 */
function getCharRatio(term) {
  const dims = term._core?._renderService?.dimensions;
  if (dims?.css?.cell?.width) {
    return dims.css.cell.width / (term.options.fontSize || 14);
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const family = term.options.fontFamily || "monospace";
  ctx.font = `14px ${family.split(",")[0].trim().replace(/'/g, "")}`;
  return ctx.measureText("W").width / 14;
}

/**
 * Calculate font size that fits cols characters in the given width.
 */
function fontSizeForWidth(term, width, cols) {
  const charRatio = getCharRatio(term);
  const exactSize = width / (cols * charRatio);
  return Math.max(6, Math.floor(exactSize * 2) / 2);
}

/** Parse a session name into project and role parts. */
function parseSessionName(sessionName) {
  const idx = sessionName.indexOf("--");
  if (idx === -1) return { project: sessionName, role: sessionName };
  return {
    project: sessionName.slice(0, idx),
    role: sessionName.slice(idx + 2),
  };
}

/**
 * Create the crew tile factory.
 *
 * @param {object} deps
 * @param {object} deps.terminalPool — shared terminal pool (used for promote-to-full)
 * @param {function} deps.createTileFn — createTile from registry
 * @param {object} deps.carousel — card carousel instance (lazy getter)
 * @returns {(options: object) => TilePrototype}
 */
export function createCrewTileFactory(deps) {
  const { terminalPool, createTileFn, carousel } = deps;

  return function createCrewTile(options = {}) {
    const {
      project = "katulong",
      sessions: initialSessions = [],
      title,
    } = options;

    let container = null;
    let gridEl = null;
    let statusBar = null;
    let mounted = false;
    let ctx = null;

    // Mini-terminal cells: sessionName -> { term, container, label, eventSource, status }
    const cells = new Map();
    let discoveryTimer = null;

    // ── Mini-terminal creation ──────────────────────────────────────

    function createMiniTerminal(sessionName) {
      const { role } = parseSessionName(sessionName);

      // Cell wrapper
      const cellEl = document.createElement("div");
      cellEl.className = "crew-cell";

      // Label bar
      const labelEl = document.createElement("div");
      labelEl.className = "crew-cell-label";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = role;
      const dotEl = document.createElement("span");
      dotEl.className = "status-dot";
      labelEl.appendChild(nameSpan);
      labelEl.appendChild(dotEl);
      cellEl.appendChild(labelEl);

      // Terminal container
      const termContainer = document.createElement("div");
      termContainer.className = "crew-cell-terminal";
      cellEl.appendChild(termContainer);

      // Create independent xterm instance (NOT from pool)
      const term = new Terminal({
        fontSize: 8,
        cols: 80,
        rows: 12,
        scrollback: 100,
        disableStdin: true,
        cursorBlink: false,
        convertEol: true,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        theme: {
          background: "#1a1a2e",
        },
      });

      term.open(termContainer);
      loadWebGL(term);

      // Subscribe to session output via SSE pub/sub endpoint
      const topic = `sessions/${sessionName}/output`;
      const sseUrl = `${basePath}/sub/${topic}`;
      let eventSource = null;
      try {
        eventSource = new EventSource(sseUrl);
        eventSource.onmessage = (event) => {
          try {
            const envelope = JSON.parse(event.data);
            // The broker publishes raw terminal output as the message string
            if (envelope.message) {
              term.write(envelope.message);
            }
          } catch {
            // Non-JSON data — write directly
            term.write(event.data);
          }
        };
        eventSource.onerror = () => {
          // SSE reconnects automatically; mark as potentially disconnected
          const cell = cells.get(sessionName);
          if (cell) updateCellStatus(cell, "idle");
        };
      } catch {
        // EventSource not supported — degrade gracefully
      }

      // Click to promote to full terminal view
      cellEl.addEventListener("click", () => promoteToFull(sessionName));
      cellEl.addEventListener("touchend", (e) => {
        e.preventDefault();
        promoteToFull(sessionName);
      });

      const cell = {
        sessionName,
        term,
        container: cellEl,
        termContainer,
        label: labelEl,
        dot: dotEl,
        eventSource,
        status: "active",
      };

      cells.set(sessionName, cell);
      return cell;
    }

    /** Dispose a single mini-terminal cell. */
    function disposeCell(cell) {
      if (cell.eventSource) {
        cell.eventSource.close();
        cell.eventSource = null;
      }
      cell.term.dispose();
      cell.container.remove();
      cells.delete(cell.sessionName);
    }

    // ── Promote to full view ────────────────────────────────────────

    function promoteToFull(sessionName) {
      const car = typeof carousel === "object" && carousel;
      if (!car) return;

      // Check if a card already exists for this session
      const existing = car.findCard(sessionName);
      if (existing) {
        car.focusCard(sessionName);
        return;
      }

      // Create a new terminal tile and add it to the carousel
      const tile = createTileFn("terminal", { sessionName });
      car.addCard(sessionName, tile);
      car.focusCard(sessionName);
    }

    // ── Status tracking ─────────────────────────────────────────────

    function updateCellStatus(cell, status) {
      cell.status = status;
      cell.dot.className = "status-dot";
      if (status === "idle") cell.dot.classList.add("idle");
      if (status === "done") cell.dot.classList.add("done");
      updateStatusBar();
    }

    function updateStatusBar() {
      if (!statusBar) return;
      let active = 0, idle = 0, done = 0;
      for (const cell of cells.values()) {
        if (cell.status === "active") active++;
        else if (cell.status === "idle") idle++;
        else done++;
      }
      const parts = [];
      if (active > 0) parts.push(`${active} active`);
      if (idle > 0) parts.push(`${idle} idle`);
      if (done > 0) parts.push(`${done} done`);
      statusBar.textContent = parts.join(" \u00b7 ") || "no sessions";
    }

    // ── Session discovery ───────────────────────────────────────────

    async function discoverSessions() {
      try {
        const sessionList = await api.get(`${basePath}/sessions`);
        const prefix = `${project}--`;
        const crewSessions = sessionList
          .map((s) => (typeof s === "string" ? s : s.name))
          .filter((name) => name.startsWith(prefix));

        // Add new sessions
        for (const name of crewSessions) {
          if (!cells.has(name)) {
            const cell = createMiniTerminal(name);
            if (gridEl) gridEl.appendChild(cell.container);
            scaleMiniTerminal(cell);
          }
        }

        // Remove sessions that no longer exist
        for (const [name, cell] of cells) {
          if (!crewSessions.includes(name)) {
            disposeCell(cell);
          }
        }

        updateStatusBar();
      } catch {
        // Network error — retry on next poll
      }
    }

    // ── Scaling ─────────────────────────────────────────────────────

    function scaleMiniTerminal(cell) {
      const rect = cell.termContainer.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const cols = 80;
      const fontSize = fontSizeForWidth(cell.term, rect.width - 4, cols);
      cell.term.options.fontSize = fontSize;

      // Calculate rows from available height
      const cellHeight = fontSize * 1.2;
      const rows = Math.max(2, Math.floor(rect.height / cellHeight));

      if (cell.term.cols !== cols || cell.term.rows !== rows) {
        cell.term.resize(cols, rows);
      }
    }

    function scaleAll() {
      for (const cell of cells.values()) {
        scaleMiniTerminal(cell);
      }
    }

    // ── Session status polling ──────────────────────────────────────

    async function pollSessionStatus() {
      try {
        const sessionList = await api.get(`${basePath}/sessions`);
        const sessionMap = new Map();
        for (const s of sessionList) {
          const name = typeof s === "string" ? s : s.name;
          sessionMap.set(name, s);
        }

        for (const [name, cell] of cells) {
          if (!sessionMap.has(name)) {
            updateCellStatus(cell, "done");
          } else {
            const info = sessionMap.get(name);
            // If the session object has status info, use it
            if (info.childProcesses === 0 || info.idle) {
              updateCellStatus(cell, "idle");
            } else {
              updateCellStatus(cell, "active");
            }
          }
        }
      } catch {
        // Network error — skip this poll
      }
    }

    // ── Tile interface ──────────────────────────────────────────────

    return {
      type: "crew",

      mount(el, tileCtx) {
        container = el;
        ctx = tileCtx;
        mounted = true;

        // Grid container
        gridEl = document.createElement("div");
        gridEl.className = "crew-grid";

        // Status bar
        statusBar = document.createElement("div");
        statusBar.className = "crew-status-bar";
        statusBar.textContent = "discovering sessions\u2026";

        container.appendChild(gridEl);
        container.appendChild(statusBar);

        // Create cells for explicitly listed sessions
        for (const sessionName of initialSessions) {
          const cell = createMiniTerminal(sessionName);
          gridEl.appendChild(cell.container);
        }

        // Scale after DOM insertion (need layout dimensions)
        requestAnimationFrame(() => {
          scaleAll();
          updateStatusBar();
        });

        // Auto-discover additional sessions and poll status
        discoverSessions();
        discoveryTimer = setInterval(() => {
          discoverSessions();
          pollSessionStatus();
        }, 5000);
      },

      unmount() {
        if (!mounted) return;

        // Stop polling
        if (discoveryTimer) {
          clearInterval(discoveryTimer);
          discoveryTimer = null;
        }

        // Dispose all mini-terminals
        for (const cell of cells.values()) {
          if (cell.eventSource) {
            cell.eventSource.close();
            cell.eventSource = null;
          }
          cell.term.dispose();
        }
        cells.clear();

        gridEl?.remove();
        statusBar?.remove();
        gridEl = null;
        statusBar = null;
        container = null;
        ctx = null;
        mounted = false;
      },

      focus() {
        // Crew tile itself doesn't need focus — mini-terminals are read-only
        requestAnimationFrame(() => scaleAll());
      },

      blur() {
        // Nothing to do — SSE streams keep running
      },

      resize() {
        requestAnimationFrame(() => scaleAll());
      },

      getTitle() {
        return title || `${project} crew`;
      },

      getIcon() {
        return "users-three";
      },

      serialize() {
        return {
          type: "crew",
          project,
          sessions: Array.from(cells.keys()),
          title: title || undefined,
        };
      },

      restore(state) {
        // Sessions are re-discovered on mount; nothing to restore beyond
        // what the factory options already provide.
      },

      /** Expose project name for external use. */
      project,
    };
  };
}
