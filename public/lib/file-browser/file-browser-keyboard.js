/**
 * File Browser Keyboard Handler — factory for keydown event handling.
 *
 * Takes a nav controller and a getState function. Returns an event
 * handler that the component wires to the columns container's keydown.
 * Testable without DOM — just needs a synthetic KeyboardEvent and
 * a mock nav/getState.
 */

import { filterHidden } from "/lib/file-browser/file-browser-store.js";

/**
 * @param {object} nav — navigation controller (selectItem, goBack)
 * @param {object} store — file-browser store (getState, dispatch)
 * @returns {(e: KeyboardEvent) => void}
 */
export function createKeyboardHandler(nav, store) {
  const getState = store.getState.bind(store);
  return function handleKeyDown(e) {
    const state = getState();
    if (state.columns.length === 0) return;

    // Find the "active" column (last column with a selection, or the last column)
    let activeColIdx = state.columns.length - 1;
    for (let i = state.columns.length - 1; i >= 0; i--) {
      if (state.columns[i].selected !== null) {
        activeColIdx = i;
        break;
      }
    }
    const col = state.columns[activeColIdx];
    if (!col) return;

    const entries = filterHidden(col.entries, state.showHidden);
    const selectedName = col.selected;
    const names = entries.map(en => en.name);
    const currentIdx = selectedName ? names.indexOf(selectedName) : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(currentIdx + 1, names.length - 1);
      if (next >= 0) nav.selectItem(activeColIdx, names[next]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = currentIdx <= 0 ? 0 : currentIdx - 1;
      if (names.length > 0) nav.selectItem(activeColIdx, names[prev]);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      // Drill into selected folder
      if (selectedName) {
        const entry = entries.find(en => en.name === selectedName);
        if (entry?.type === "directory" && state.columns[activeColIdx + 1]) {
          // Focus the next column — select its first visible item
          const nextCol = state.columns[activeColIdx + 1];
          const nextVisible = filterHidden(nextCol.entries, state.showHidden);
          if (nextVisible.length > 0) {
            nav.selectItem(activeColIdx + 1, nextVisible[0].name);
          }
        }
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      // Go up to parent column. Use synchronous dispatch (not nav.selectItem)
      // because we just want to trim columns, not re-fetch the directory.
      if (activeColIdx > 0) {
        const parentCol = state.columns[activeColIdx - 1];
        if (parentCol.selected) {
          store.dispatch({ type: "SELECT_ITEM", columnIndex: activeColIdx - 1, name: parentCol.selected });
        }
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedName) {
        const entry = entries.find(en => en.name === selectedName);
        if (entry?.type === "file") {
          const filePath = col.path + "/" + selectedName;
          window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, "_blank");
        }
      }
    } else if (e.key === "Backspace") {
      e.preventDefault();
      nav.goBack();
    }
  };
}
