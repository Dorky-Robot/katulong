/**
 * Split Manager (iPad/tablet only)
 *
 * Manages two-pane split terminal layout.
 * Landscape: side-by-side (row). Portrait: stacked (column).
 * Only two splits maximum. Drag a tab into the terminal area to split.
 */

// Detect tablet: has touch + wide screen. Media queries are unreliable on iPad
// (Magic Keyboard changes pointer type), so use maxTouchPoints instead.
function detectTablet() {
  return navigator.maxTouchPoints > 0 && window.innerWidth >= 768;
}

export function createSplitManager({ terminalContainer, terminalPool, sendResize }) {
  let active = false;
  let pane1Session = null;
  let pane2Session = null;
  const pane2Sessions = new Set(); // all sessions assigned to pane 2
  let dividerEl = null;
  let _onFocusChange = null;
  let _onSplitChanged = null;
  const focusCleanups = [];

  function getDirection() {
    return window.matchMedia("(orientation: landscape)").matches ? "row" : "column";
  }

  // ── Split lifecycle ──────────────────────────────────────────────────

  function split(session1, session2) {
    if (!detectTablet()) return;
    active = true;
    pane1Session = session1;
    pane2Session = session2;
    pane2Sessions.add(session2);

    // Ensure both terminals exist
    terminalPool.getOrCreate(session1);
    terminalPool.getOrCreate(session2);

    applyLayout();
    setupFocusTracking();
    if (_onSplitChanged) _onSplitChanged({ isSplit: true, pane1: pane1Session, pane2: pane2Session });
  }

  function unsplit(keepSession) {
    if (!active) return;
    active = false;
    const keep = keepSession || pane1Session;
    pane2Sessions.clear();
    pane1Session = keep;
    pane2Session = null;

    cleanupFocusTracking();
    // Clear inline styles from split layout
    terminalContainer.style.display = "";
    terminalContainer.style.flexDirection = "";
    removeDivider();

    // Clear inline styles from all panes
    terminalPool.forEach((_name, entry) => {
      entry.container.style.display = "";
      entry.container.style.position = "";
      entry.container.style.inset = "";
      entry.container.style.flex = "";
      entry.container.style.minWidth = "";
      entry.container.style.minHeight = "";
      entry.container.style.overflow = "";
      entry.container.style.order = "";
    });

    // Restore single-pane mode
    if (keep) terminalPool.activate(keep);
    if (_onSplitChanged) _onSplitChanged({ isSplit: false, pane1: keep, pane2: null });
  }

  // ── Layout ───────────────────────────────────────────────────────────

  function applyLayout() {
    if (!active || !pane1Session || !pane2Session) return;

    const dir = getDirection();

    // Apply layout with inline styles (CSS classes were unreliable on iPad Safari)
    terminalContainer.style.display = "flex";
    terminalContainer.style.flexDirection = dir === "row" ? "row" : "column";

    terminalPool.forEach((name, entry) => {
      const isP1 = name === pane1Session;
      const isP2 = name === pane2Session;
      entry.container.classList.remove("active");

      if (isP1 || isP2) {
        // Make visible as flex child
        entry.container.style.display = "block";
        entry.container.style.position = "relative";
        entry.container.style.inset = "auto";
        entry.container.style.flex = "1";
        entry.container.style.minWidth = "0";
        entry.container.style.minHeight = "0";
        entry.container.style.overflow = "hidden";
        entry.container.style.order = isP1 ? "1" : "3";
      } else {
        // Hide other panes
        entry.container.style.display = "none";
      }
    });

    ensureDivider();
    fitAll();
  }

  function fitPane(session) {
    const entry = terminalPool.get(session);
    if (!entry) return;
    entry.fit.fit();
    if (sendResize) sendResize(session, entry.term.cols, entry.term.rows);
  }

  function fitAll() {
    if (!active) return;
    requestAnimationFrame(() => {
      fitPane(pane1Session);
      fitPane(pane2Session);
    });
  }

  // ── Divider ──────────────────────────────────────────────────────────

  function ensureDivider() {
    const dir = getDirection();
    if (!dividerEl) {
      dividerEl = document.createElement("div");
      dividerEl.addEventListener("dblclick", () => unsplit());
    }
    // Always update style based on current direction (handles orientation changes)
    dividerEl.style.cssText = dir === "row"
      ? "order:2; flex-shrink:0; width:3px; background:var(--accent-active); cursor:col-resize;"
      : "order:2; flex-shrink:0; height:3px; background:var(--accent-active); cursor:row-resize;";
    if (!dividerEl.parentElement) {
      terminalContainer.appendChild(dividerEl);
    }
  }

  function removeDivider() {
    if (dividerEl) {
      dividerEl.remove();
      dividerEl = null;
    }
  }

  // ── Focus tracking ───────────────────────────────────────────────────

  function setupFocusTracking() {
    cleanupFocusTracking();
    terminalPool.forEach((name, entry) => {
      const handler = () => {
        if (active && (name === pane1Session || name === pane2Session)) {
          if (_onFocusChange) _onFocusChange(name);
        }
      };
      entry.container.addEventListener("pointerdown", handler);
      focusCleanups.push(() => entry.container.removeEventListener("pointerdown", handler));
    });
  }

  function cleanupFocusTracking() {
    for (const fn of focusCleanups) fn();
    focusCleanups.length = 0;
  }

  // ── Pane management ──────────────────────────────────────────────────

  function switchPaneSession(pane, newSession) {
    terminalPool.getOrCreate(newSession);
    if (pane === 1) {
      pane2Sessions.delete(newSession);
      pane1Session = newSession;
    } else {
      pane2Sessions.add(newSession);
      pane2Session = newSession;
    }
    applyLayout();
    setupFocusTracking();
  }

  function getPaneForSession(name) {
    return pane2Sessions.has(name) ? 2 : 1;
  }

  function getOtherSession(sessionName) {
    if (sessionName === pane1Session) return pane2Session;
    if (sessionName === pane2Session) return pane1Session;
    return null;
  }

  // ── Orientation change ───────────────────────────────────────────────

  window.matchMedia("(orientation: landscape)").addEventListener("change", () => {
    if (active) applyLayout();
  });

  return {
    split,
    unsplit,
    isSplit: () => active,
    isTablet: detectTablet,
    getDirection,
    getPane1: () => pane1Session,
    getPane2: () => pane2Session,
    getPaneForSession,
    getOtherSession,
    switchPaneSession,
    isInPane2: (name) => pane2Sessions.has(name),
    addToPane2: (name) => pane2Sessions.add(name),
    removeFromPane2: (name) => pane2Sessions.delete(name),
    applyLayout,
    fitAll,
    // Callbacks
    set onFocusChange(fn) { _onFocusChange = fn; },
    set onSplitChanged(fn) { _onSplitChanged = fn; },
    get pane2Sessions() { return pane2Sessions; },
  };
}
