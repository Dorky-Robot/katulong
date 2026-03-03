/**
 * File Browser Store — Miller Columns
 *
 * State is an array of columns. Each column has a path, entries, and selected item.
 * Clicking a folder in column N loads column N+1 and trims anything beyond.
 */

import { createStore, createReducer } from "/lib/store.js";
import { api } from "/lib/api-client.js";

const initialState = {
  columns: [],         // [{ path, entries, selected, loading, error }]
  clipboard: null,     // { action: "copy"|"cut", items: [...paths] }
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

  // Set error on a column
  SET_COLUMN_ERROR: (state, { index, error }) => {
    const columns = [...state.columns];
    if (columns[index]) {
      columns[index] = { ...columns[index], loading: false, error };
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
};

export function createFileBrowserStore() {
  const reducer = createReducer(initialState, handlers);
  return createStore(initialState, reducer);
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
 * Load the root column (first column) at the given path.
 */
export async function loadRoot(store, path) {
  store.dispatch({ type: "SET_COLUMN_LOADING", index: 0, path });
  try {
    const data = await api.get(`/api/files?path=${encodeURIComponent(path)}`);
    store.dispatch({ type: "SET_COLUMN", index: 0, path: data.path, entries: sortEntries(data.entries) });
  } catch (err) {
    store.dispatch({ type: "SET_COLUMN_ERROR", index: 0, error: err.message });
  }
}

/**
 * Select an item in a column. If it's a directory, load its contents in the next column.
 * If it's a file, just select it (trim columns after).
 */
export async function selectItem(store, columnIndex, name) {
  const state = store.getState();
  const col = state.columns[columnIndex];
  if (!col) return;

  const entry = col.entries.find(e => e.name === name);
  if (!entry) return;

  // Set selection on this column
  store.dispatch({ type: "SELECT_ITEM", columnIndex, name });

  if (entry.type === "directory") {
    const childPath = col.path + "/" + name;
    const nextIndex = columnIndex + 1;
    store.dispatch({ type: "SET_COLUMN_LOADING", index: nextIndex, path: childPath });
    try {
      const data = await api.get(`/api/files?path=${encodeURIComponent(childPath)}`);
      store.dispatch({ type: "SET_COLUMN", index: nextIndex, path: data.path, entries: sortEntries(data.entries) });
    } catch (err) {
      store.dispatch({ type: "SET_COLUMN_ERROR", index: nextIndex, error: err.message });
    }
  }
}

/**
 * Navigate back: remove the last column.
 */
export function goBack(store) {
  const state = store.getState();
  if (state.columns.length <= 1) return;
  const parentIndex = state.columns.length - 2;
  store.dispatch({ type: "CLEAR_SELECTION", columnIndex: parentIndex });
}

/**
 * Refresh all columns (re-fetch each in sequence).
 */
export async function refreshAll(store) {
  const state = store.getState();
  for (let i = 0; i < state.columns.length; i++) {
    const col = state.columns[i];
    try {
      const data = await api.get(`/api/files?path=${encodeURIComponent(col.path)}`);
      store.dispatch({ type: "SET_COLUMN", index: i, path: data.path, entries: sortEntries(data.entries) });
      // Re-select previously selected item if it still exists
      if (col.selected && data.entries.some(e => e.name === col.selected)) {
        store.dispatch({ type: "SELECT_ITEM", columnIndex: i, name: col.selected });
      }
    } catch {
      break; // Stop refreshing deeper columns if a parent fails
    }
  }
}

/**
 * Get the deepest path from the current column state.
 */
export function getDeepestPath(state) {
  const { columns } = state;
  if (columns.length === 0) return "/";
  return columns[columns.length - 1].path;
}

