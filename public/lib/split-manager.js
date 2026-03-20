/**
 * Split Manager (iPad/tablet only)
 *
 * Manages two-pane split terminal layout.
 * Landscape: side-by-side (row). Portrait: stacked (column).
 * Only two splits maximum. Drag a tab into the terminal area to split.
 */

// Detect iPad: touch-capable + wide screen + no fine pointer (mouse/trackpad) as primary.
// iPads with Magic Keyboard report (pointer: fine) but (any-pointer: coarse) is still true.
// Desktop touchscreens have (pointer: fine) AND no (any-pointer: coarse) from a separate
// touch digitizer — but actually they do, so we also check for the absence of a desktop UA.
// Simplest reliable check: coarse touch available + tablet-sized + NOT a desktop OS.
function detectTablet() {
  if (navigator.maxTouchPoints === 0) return false;
  if (window.innerWidth < 768) return false;
  // Exclude desktop: desktops have (pointer: fine) as primary and no coarse-only mode
  // iPads always have (any-pointer: coarse). Desktop touch laptops also have it, but
  // they additionally match (hover: hover) which iPads without a trackpad don't.
  // With Magic Keyboard, iPad matches (hover: hover) too, so fall back to UA sniffing.
  const ua = navigator.userAgent || "";
  // iPad Safari reports as "Macintosh" but has maxTouchPoints > 0
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // Android tablets
  const isAndroidTablet = /Android/.test(ua) && !/Mobile/.test(ua);
  return isIPad || isAndroidTablet;
}

const SPLIT_STATE_KEY = "katulong-split-state";

export function createSplitManager({ terminalContainer, terminalPool, sendResize }) {
  let active = false;
  let pane1Session = null;
  let pane2Session = null;
  const pane2Sessions = new Set(); // all sessions assigned to pane 2
  let dividerEl = null;
  let _onFocusChange = null;
  let _onSplitChanged = null;
  const focusCleanups = [];

  // ── Persistence ────────────────────────────────────────────────────

  function saveState() {
    try {
      const state = active
        ? { active: true, pane1: pane1Session, pane2: pane2Session, pane2List: [...pane2Sessions] }
        : null;
      if (state) {
        sessionStorage.setItem(SPLIT_STATE_KEY, JSON.stringify(state));
      } else {
        sessionStorage.removeItem(SPLIT_STATE_KEY);
      }
    } catch { /* sessionStorage unavailable */ }
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(SPLIT_STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function getDirection() {
    // Use screen orientation API (physical device orientation) rather than
    // viewport aspect ratio, so the split direction stays correct regardless
    // of window size (e.g., iPad multitasking split).
    if (screen.orientation?.type) {
      return screen.orientation.type.startsWith("landscape") ? "row" : "column";
    }
    // Fallback: check screen dimensions (physical, not viewport)
    return screen.width > screen.height ? "row" : "column";
  }

  // ── Split lifecycle ──────────────────────────────────────────────────

  function split(session1, session2) {
    if (!detectTablet()) return;
    if (window.innerWidth < MIN_SPLIT_WIDTH) return;
    active = true;
    pane1Session = session1;
    pane2Session = session2;
    pane2Sessions.add(session2);

    // Ensure both terminals exist
    terminalPool.getOrCreate(session1);
    terminalPool.getOrCreate(session2);

    applyLayout();
    setupFocusTracking();
    saveState();
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
    delete terminalContainer.dataset.split;
    removeDivider();

    // Move all terminal panes back to terminalContainer (out of wrappers)
    terminalPool.forEach((_name, entry) => {
      if (entry.container.parentElement !== terminalContainer) {
        terminalContainer.appendChild(entry.container);
      }
      entry.container.classList.remove("split-hidden");
    });

    // Remove split-pane wrappers, divider remnants, and pane-tabs elements
    const wrappers = terminalContainer.querySelectorAll
      ? terminalContainer.querySelectorAll(".split-pane, .split-pane-tabs")
      : [];
    for (const el of wrappers) el.remove();

    // Restore single-pane mode
    if (keep) terminalPool.activate(keep);
    saveState();
    if (_onSplitChanged) _onSplitChanged({ isSplit: false, pane1: keep, pane2: null });
  }

  // ── Layout ───────────────────────────────────────────────────────────

  function applyLayout() {
    if (!active || !pane1Session || !pane2Session) return;

    const dir = getDirection();
    terminalContainer.dataset.split = dir;

    // Ensure wrapper elements exist
    let paneWrapper1 = terminalContainer.querySelector(".split-pane-1");
    let paneWrapper2 = terminalContainer.querySelector(".split-pane-2");

    if (!paneWrapper1) {
      paneWrapper1 = document.createElement("div");
      paneWrapper1.className = "split-pane split-pane-1";
    }
    if (!paneWrapper2) {
      paneWrapper2 = document.createElement("div");
      paneWrapper2.className = "split-pane split-pane-2";
    }

    // Move pane 1 terminal into its wrapper
    const entry1 = terminalPool.get(pane1Session);
    if (entry1 && entry1.container.parentElement !== paneWrapper1) {
      paneWrapper1.appendChild(entry1.container);
    }

    // Move pane 2 terminal into its wrapper
    const entry2 = terminalPool.get(pane2Session);
    if (entry2 && entry2.container.parentElement !== paneWrapper2) {
      paneWrapper2.appendChild(entry2.container);
    }

    // Assemble DOM: pane1, divider, pane2
    ensureDivider();
    if (!paneWrapper1.parentElement) terminalContainer.appendChild(paneWrapper1);
    if (!dividerEl.parentElement) terminalContainer.appendChild(dividerEl);
    if (!paneWrapper2.parentElement) terminalContainer.appendChild(paneWrapper2);

    // Ensure correct DOM order: pane1, divider, pane2
    terminalContainer.insertBefore(paneWrapper1, terminalContainer.firstChild);
    terminalContainer.insertBefore(dividerEl, paneWrapper1.nextSibling);
    terminalContainer.insertBefore(paneWrapper2, dividerEl.nextSibling);

    // In portrait (column) mode, create split-pane-tabs in pane2 before the terminal
    const existingTabs = paneWrapper2.querySelector(".split-pane-tabs");
    if (dir === "column") {
      if (!existingTabs) {
        const tabsEl = document.createElement("div");
        tabsEl.className = "split-pane-tabs";
        paneWrapper2.insertBefore(tabsEl, paneWrapper2.firstChild);
      }
    } else {
      // Row mode: remove pane-tabs if present
      if (existingTabs) existingTabs.remove();
    }

    // Hide non-active panes, show active ones
    terminalPool.forEach((name, entry) => {
      const isP1 = name === pane1Session;
      const isP2 = name === pane2Session;
      entry.container.classList.remove("active");

      if (isP1 || isP2) {
        entry.container.classList.remove("split-hidden");
      } else {
        entry.container.classList.add("split-hidden");
      }
    });

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
    if (!dividerEl) {
      dividerEl = document.createElement("div");
      dividerEl.className = "split-divider";
      dividerEl.addEventListener("dblclick", () => unsplit());
    }
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
    // Only register on the two active split panes, not all pool entries
    for (const session of [pane1Session, pane2Session]) {
      if (!session) continue;
      const entry = terminalPool.get(session);
      if (!entry) continue;
      const handler = () => {
        if (active && _onFocusChange) _onFocusChange(session);
      };
      entry.container.addEventListener("pointerdown", handler);
      focusCleanups.push(() => entry.container.removeEventListener("pointerdown", handler));
    }
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
    saveState();
    // Re-register focus handlers only for the current active panes
    // (cleanupFocusTracking removes all old handlers first)
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

  // ── Orientation & resize ──────────────────────────────────────────────

  const MIN_SPLIT_WIDTH = 500; // px — auto-unsplit below this width

  function onOrientationOrResize() {
    if (!active) return;
    // Auto-unsplit if window is too narrow (e.g., iPad multitasking slim mode)
    if (window.innerWidth < MIN_SPLIT_WIDTH) {
      unsplit(pane1Session);
      return;
    }
    applyLayout();
    if (_onSplitChanged) _onSplitChanged({ isSplit: true, pane1: pane1Session, pane2: pane2Session });
  }

  // Listen for device orientation changes
  if (screen.orientation) {
    screen.orientation.addEventListener("change", onOrientationOrResize);
  } else {
    window.matchMedia("(orientation: landscape)").addEventListener("change", onOrientationOrResize);
  }
  // Also listen for window resize (iPad multitasking slider)
  window.addEventListener("resize", onOrientationOrResize);

  /** Restore split state from sessionStorage (call after app is fully initialized) */
  function restore() {
    const saved = loadState();
    if (!saved || !saved.active) return false;
    if (!detectTablet()) return false;
    // Restore pane2Sessions set
    if (saved.pane2List) {
      for (const name of saved.pane2List) pane2Sessions.add(name);
    }
    // Re-activate the split
    split(saved.pane1, saved.pane2);
    return active;
  }

  return {
    split,
    unsplit,
    restore,
    isSplit: () => active,
    isTablet: detectTablet,
    getDirection,
    getPane1: () => pane1Session,
    getPane2: () => pane2Session,
    getPaneForSession,
    getOtherSession,
    switchPaneSession,
    isInPane2: (name) => pane2Sessions.has(name),
    addToPane2: (name) => { pane2Sessions.add(name); saveState(); },
    removeFromPane2: (name) => { pane2Sessions.delete(name); saveState(); },
    applyLayout,
    fitAll,
    // Callbacks
    set onFocusChange(fn) { _onFocusChange = fn; },
    set onSplitChanged(fn) { _onSplitChanged = fn; },
    get pane2Sessions() { return pane2Sessions; },
  };
}
