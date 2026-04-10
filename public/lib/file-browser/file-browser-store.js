/**
 * File Browser Store — Miller Columns
 *
 * State is an array of columns. Each column has a path, entries, and selected item.
 * Clicking a folder in column N loads column N+1 and trims anything beyond.
 *
 * Navigation actions (loadRoot, selectItem, refreshAll, goBack) live in
 * createNavController() — a per-instance factory that scopes request
 * cancellation via a generation counter. See docs/file-browser-refactor.md.
 */

import { createStore, createReducer } from "/lib/store.js";

const initialState = {
  columns: [],         // [{ path, entries, selected, loading, error }]
  clipboard: null,     // { action: "copy"|"cut", items: [...paths] }
  showHidden: localStorage.getItem("katulong-fb-show-hidden") === "1",
};

const handlers = {
  // Set column data (entries loaded)
  SET_COLUMN: (state, { index, path, entries }) => {
    const columns = state.columns.slice(0, index);
    columns[index] = { path, entries, selected: null, loading: false, error: null };
    return { ...state, columns };
  },

  // Mark a column as loading (and trim everything after it)
  SET_COLUMN_LOADING: (state, { index, path }) => {
    const columns = state.columns.slice(0, index);
    columns[index] = { path, entries: [], selected: null, loading: true, error: null };
    return { ...state, columns };
  },

  // Set error on a column. Creates the column entry if it was trimmed
  // by a concurrent SET_COLUMN dispatch (e.g. refreshAll rebuilds the
  // chain sequentially — column N's SET_COLUMN trims N+1, then N+1's
  // error needs somewhere to land).
  SET_COLUMN_ERROR: (state, { index, path, error, hint }) => {
    const columns = [...state.columns];
    if (columns[index]) {
      columns[index] = { ...columns[index], loading: false, error, hint: hint || null };
    } else {
      columns[index] = { path: path || "", entries: [], selected: null, loading: false, error, hint: hint || null };
    }
    return { ...state, columns };
  },

  // Select an item in a column (and trim columns after it)
  SELECT_ITEM: (state, { columnIndex, name }) => {
    const columns = state.columns.slice(0, columnIndex + 1);
    columns[columnIndex] = { ...columns[columnIndex], selected: name };
    return { ...state, columns };
  },

  // Clear selection in a column
  CLEAR_SELECTION: (state, { columnIndex }) => {
    const columns = [...state.columns];
    if (columns[columnIndex]) {
      columns[columnIndex] = { ...columns[columnIndex], selected: null };
    }
    // Trim columns after
    return { ...state, columns: columns.slice(0, columnIndex + 1) };
  },

  SET_CLIPBOARD: (state, { clipboard }) => ({ ...state, clipboard }),

  TOGGLE_HIDDEN: (state) => {
    const showHidden = !state.showHidden;
    localStorage.setItem("katulong-fb-show-hidden", showHidden ? "1" : "0");
    return { ...state, showHidden };
  },
};

export function createFileBrowserStore() {
  const reducer = createReducer(initialState, handlers);
  return createStore(initialState, reducer);
}

/**
 * Filter hidden (dotfile) entries based on showHidden flag.
 */
export function filterHidden(entries, showHidden) {
  if (showHidden) return entries;
  return entries.filter(e => !e.name.startsWith("."));
}

/**
 * Sort entries: directories first, then alphabetical.
 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Get the deepest path from the current column state.
 */
export function getDeepestPath(state) {
  const { columns } = state;
  if (columns.length === 0) return "/";
  return columns[columns.length - 1].path;
}

// ─── Fetch with timeout ─────────────────────────────────────────────
// File browser needs stricter latency guarantees than general API
// callers. Raw fetch() has no timeout — if the tunnel drops, the
// promise hangs forever and the spinner never clears. This wrapper
// aborts after `ms` milliseconds so SET_COLUMN_ERROR always fires.

const DEFAULT_TIMEOUT_MS = 15000;

async function fetchDir(url, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // Try to parse structured error from server (includes hint, tcc flag)
      let body;
      try { body = await res.json(); } catch { /* ignore */ }
      const err = new Error(body?.error || `GET ${url} failed (${res.status})`);
      if (body?.hint) err.hint = body.hint;
      if (body?.tcc) err.tcc = true;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Request timed out — the server may be unreachable");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Navigation controller ──────────────────────────────────────────
// Scoped per store instance so multiple file-browser tiles don't share
// cancellation state. The generation counter is the simplest vanilla JS
// pattern for "only the latest request matters": increment before the
// await, check after — if it moved, a newer navigation superseded us.

/**
 * Create a navigation controller bound to a file-browser store.
 *
 * @param {object} store — file-browser store instance
 * @returns {{ loadRoot, selectItem, refreshAll, goBack }}
 */
export function createNavController(store) {
  let generation = 0;

  async function loadRoot(path) {
    const gen = ++generation;
    store.dispatch({ type: "SET_COLUMN_LOADING", index: 0, path });
    try {
      const data = await fetchDir(`/api/files?path=${encodeURIComponent(path)}`);
      if (gen !== generation) return;
      store.dispatch({ type: "SET_COLUMN", index: 0, path: data.path, entries: sortEntries(data.entries) });
    } catch (err) {
      if (gen !== generation) return;
      store.dispatch({ type: "SET_COLUMN_ERROR", index: 0, error: err.message, hint: err.hint });
    }
  }

  async function selectItem(columnIndex, name) {
    const state = store.getState();
    const col = state.columns[columnIndex];
    if (!col) return;

    const entry = col.entries.find(e => e.name === name);
    if (!entry) return;

    store.dispatch({ type: "SELECT_ITEM", columnIndex, name });

    if (entry.type === "directory") {
      const childPath = col.path + "/" + name;
      const nextIndex = columnIndex + 1;
      const gen = ++generation;
      store.dispatch({ type: "SET_COLUMN_LOADING", index: nextIndex, path: childPath });
      try {
        const data = await fetchDir(`/api/files?path=${encodeURIComponent(childPath)}`);
        if (gen !== generation) return;
        store.dispatch({ type: "SET_COLUMN", index: nextIndex, path: data.path, entries: sortEntries(data.entries) });
      } catch (err) {
        if (gen !== generation) return;
        store.dispatch({ type: "SET_COLUMN_ERROR", index: nextIndex, error: err.message, hint: err.hint });
      }
    }
  }

  async function refreshAll() {
    const gen = ++generation;
    // Snapshot the column paths and selections up front. We can't
    // re-read state.columns mid-loop because SET_COLUMN trims
    // everything after the dispatched index — column N+1 vanishes
    // when column N is refreshed. Instead, capture the full path
    // list once, then re-build the column chain in order.
    const snapshot = store.getState().columns.map(c => ({
      path: c.path,
      selected: c.selected,
    }));

    for (let i = 0; i < snapshot.length; i++) {
      if (gen !== generation) return;
      const { path, selected } = snapshot[i];
      try {
        const data = await fetchDir(`/api/files?path=${encodeURIComponent(path)}`);
        if (gen !== generation) return;
        store.dispatch({ type: "SET_COLUMN", index: i, path: data.path, entries: sortEntries(data.entries) });
        if (selected && data.entries.some(e => e.name === selected)) {
          store.dispatch({ type: "SELECT_ITEM", columnIndex: i, name: selected });
        }
      } catch (err) {
        if (gen !== generation) return;
        store.dispatch({ type: "SET_COLUMN_ERROR", index: i, path, error: err.message, hint: err.hint });
        break;
      }
    }
  }

  function goBack() {
    const state = store.getState();
    if (state.columns.length <= 1) return;
    const parentIndex = state.columns.length - 2;
    store.dispatch({ type: "CLEAR_SELECTION", columnIndex: parentIndex });
  }

  return { loadRoot, selectItem, refreshAll, goBack };
}
