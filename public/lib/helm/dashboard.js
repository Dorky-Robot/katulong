/**
 * Helm Dashboard
 *
 * A Notion-style grid layout for helm mode widgets. Rows hold up to 4 cells,
 * each cell contains a widget. Column and row resize via drag handles.
 * Widgets can be reordered by dragging their toolbar, with FLIP animation.
 *
 * Widget protocol:
 *   factory.create(el, context) → { update(ctx), unmount(), ...extra }
 *
 * Layout state:
 *   { rows: [{ id, height, cells: [{ id, width, widgetType, context }] }] }
 *
 * DOM preservation: widget containers are detached and re-inserted (not
 * destroyed) across layout changes. Terminal sessions, WebSocket connections,
 * and internal widget state survive rearrangement.
 */

// --- Widget registry ---

const widgetFactories = new Map();

export function registerWidget(type, factory) {
  widgetFactories.set(type, factory);
}

export function listWidgetTypes() {
  return [...widgetFactories.keys()];
}

// --- Dashboard ---

/**
 * @param {HTMLElement} el
 * @param {object} opts
 * @param {object} opts.layout - initial layout
 * @param {(layout: object) => void} opts.onLayoutChange
 * @param {(cellId: string, resolve: (type, ctx) => void) => void} opts.onAddWidget
 */
export function createDashboard(el, opts = {}) {
  const { onLayoutChange, onAddWidget } = opts;
  let layout = opts.layout || { rows: [] };
  const widgets = new Map();     // cellId → widget instance
  const widgetEls = new Map();   // cellId → widget container DOM (preserved)

  el.classList.add("helm-dashboard");

  function render() {
    // Detach widget containers (don't destroy)
    for (const [, widgetEl] of widgetEls) {
      if (widgetEl.parentNode) widgetEl.parentNode.removeChild(widgetEl);
    }
    el.innerHTML = "";

    const activeCellIds = new Set();

    for (const row of layout.rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "helm-dash-row";
      rowEl.dataset.rowId = row.id;
      if (row.height) rowEl.style.height = row.height;

      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        activeCellIds.add(cell.id);

        // Column resize handle between cells
        if (i > 0) {
          const handle = document.createElement("div");
          handle.className = "helm-col-handle";
          addDragListeners(handle, (e) => startColResize(e, row, i - 1, i));
          rowEl.appendChild(handle);
        }

        const cellEl = document.createElement("div");
        cellEl.className = "helm-dash-cell";
        cellEl.dataset.cellId = cell.id;
        cellEl.style.flex = cell.width ? `0 0 ${cell.width}` : "1";

        if (cell.widgetType) {
          let widgetEl = widgetEls.get(cell.id);
          if (!widgetEl) {
            widgetEl = document.createElement("div");
            widgetEl.className = "helm-widget-container";
            widgetEls.set(cell.id, widgetEl);

            const factory = widgetFactories.get(cell.widgetType);
            if (factory) {
              try {
                const widget = factory.create(widgetEl, cell.context || {});
                widget.type = cell.widgetType;
                widgets.set(cell.id, widget);
              } catch (err) {
                widgetEl.textContent = `Widget error: ${err.message}`;
                widgetEl.classList.add("helm-widget-error");
              }
            } else {
              widgetEl.textContent = `Unknown widget: ${cell.widgetType}`;
              widgetEl.classList.add("helm-widget-error");
            }
          }
          wireToolbarDrag(widgetEl, cell.id);
          cellEl.appendChild(widgetEl);
        } else {
          const emptyEl = document.createElement("div");
          emptyEl.className = "helm-widget-container";
          const btn = document.createElement("button");
          btn.className = "helm-add-widget";
          btn.textContent = "+ Add widget";
          btn.addEventListener("click", () => {
            if (onAddWidget) {
              onAddWidget(cell.id, (widgetType, context) => {
                cell.widgetType = widgetType;
                cell.context = context;
                notifyChange();
                render();
              });
            }
          });
          emptyEl.appendChild(btn);
          cellEl.appendChild(emptyEl);
        }

        rowEl.appendChild(cellEl);
      }

      el.appendChild(rowEl);

      // Row resize handle
      const rowHandle = document.createElement("div");
      rowHandle.className = "helm-row-handle";
      addDragListeners(rowHandle, (e) => startRowResize(e, row));
      el.appendChild(rowHandle);
    }

    // Clean up removed widgets
    for (const [cellId, widget] of widgets) {
      if (!activeCellIds.has(cellId)) {
        try { widget.unmount(); } catch { /* ok */ }
        widgets.delete(cellId);
        widgetEls.delete(cellId);
      }
    }

    // Add row button
    const addBtn = document.createElement("button");
    addBtn.className = "helm-add-row";
    addBtn.textContent = "+";
    addBtn.title = "Add row";
    addBtn.addEventListener("click", () => addRow());
    el.appendChild(addBtn);
  }

  // --- Layout mutations ---

  function addRow(cells) {
    const row = {
      id: genId(),
      height: null,
      cells: cells || [{ id: genId(), width: null, widgetType: null, context: {} }],
    };
    layout.rows.push(row);
    notifyChange();
    render();
    return row;
  }

  function addCell(rowId, widgetType, context) {
    const row = layout.rows.find((r) => r.id === rowId);
    if (!row || row.cells.length >= 4) return null;
    const cell = { id: genId(), width: null, widgetType, context: context || {} };
    row.cells.push(cell);
    notifyChange();
    render();
    return cell;
  }

  function removeCell(cellId) {
    for (const row of layout.rows) {
      const idx = row.cells.findIndex((c) => c.id === cellId);
      if (idx !== -1) {
        row.cells.splice(idx, 1);
        if (row.cells.length === 0) {
          layout.rows = layout.rows.filter((r) => r.id !== row.id);
        }
        notifyChange();
        render();
        return true;
      }
    }
    return false;
  }

  function setCellWidget(cellId, widgetType, context) {
    for (const row of layout.rows) {
      const cell = row.cells.find((c) => c.id === cellId);
      if (cell) {
        const existing = widgets.get(cellId);
        if (existing) { try { existing.unmount(); } catch {} }
        widgets.delete(cellId);
        widgetEls.delete(cellId);
        cell.widgetType = widgetType;
        cell.context = context || {};
        notifyChange();
        render();
        return true;
      }
    }
    return false;
  }

  // --- Toolbar drag wiring ---

  function wireToolbarDrag(widgetEl, cellId) {
    if (widgetEl._dashDragWired) return;
    widgetEl._dashDragWired = true;

    let toolbar = widgetEl.querySelector("[data-helm-toolbar], .helm-toolbar");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "helm-drag-strip";
      widgetEl.prepend(toolbar);
    }

    toolbar.classList.add("helm-draggable");
    toolbar.style.cursor = "grab";

    toolbar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button, input, select, textarea, a")) return;
      e.stopPropagation();
      startWidgetDrag(e, cellId);
    });
    toolbar.addEventListener("touchstart", (e) => {
      if (e.target.closest("button, input, select, textarea, a")) return;
      e.stopPropagation();
      startWidgetDrag(normTouch(e), cellId);
    }, { passive: false });
  }

  // --- Resize ---

  function addDragListeners(handle, onStart) {
    handle.addEventListener("mousedown", onStart);
    handle.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) onStart(normTouch(e));
    }, { passive: false });
  }

  function normTouch(e) {
    e.preventDefault();
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault() {} };
  }

  function startColResize(e, row, leftIdx, rightIdx) {
    e.preventDefault();
    const rowEl = el.querySelector(`[data-row-id="${row.id}"]`);
    if (!rowEl) return;

    const leftCell = rowEl.querySelector(`[data-cell-id="${row.cells[leftIdx].id}"]`);
    const rightCell = rowEl.querySelector(`[data-cell-id="${row.cells[rightIdx].id}"]`);
    if (!leftCell || !rightCell) return;

    const handles = rowEl.querySelectorAll(".helm-col-handle");
    const handleEl = handles[leftIdx];
    if (handleEl) handleEl.classList.add("active");
    el.classList.add("resizing-col");

    const startX = e.clientX;
    const rowWidth = rowEl.offsetWidth;
    const lw = leftCell.offsetWidth;
    const rw = rightCell.offsetWidth;
    const total = lw + rw;
    const min = Math.max(80, rowWidth * 0.1);

    function onMove(e) {
      const x = e.clientX ?? e.touches?.[0]?.clientX ?? startX;
      const dx = x - startX;
      const nl = Math.max(min, Math.min(total - min, lw + dx));
      const nr = total - nl;
      leftCell.style.flex = `0 0 ${((nl / rowWidth) * 100).toFixed(1)}%`;
      rightCell.style.flex = `0 0 ${((nr / rowWidth) * 100).toFixed(1)}%`;
      row.cells[leftIdx].width = leftCell.style.flex.split(" ").pop();
      row.cells[rightIdx].width = rightCell.style.flex.split(" ").pop();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
      if (handleEl) handleEl.classList.remove("active");
      el.classList.remove("resizing-col");
      notifyChange();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  }

  function startRowResize(e, row) {
    e.preventDefault();
    const rowEl = el.querySelector(`[data-row-id="${row.id}"]`);
    if (!rowEl) return;

    const handleEl = rowEl.nextElementSibling;
    if (handleEl?.classList.contains("helm-row-handle")) handleEl.classList.add("active");
    el.classList.add("resizing-row");

    const startY = e.clientY;
    const startH = rowEl.offsetHeight;

    function onMove(e) {
      const y = e.clientY ?? e.touches?.[0]?.clientY ?? startY;
      const h = Math.max(100, startH + (y - startY));
      rowEl.style.height = h + "px";
      row.height = h + "px";
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
      if (handleEl?.classList.contains("helm-row-handle")) handleEl.classList.remove("active");
      el.classList.remove("resizing-row");
      notifyChange();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  }

  // --- Widget drag-to-reorder with FLIP ---

  function startWidgetDrag(e, cellId) {
    e.preventDefault();
    const widgetEl = widgetEls.get(cellId);
    if (!widgetEl) return;

    widgetEl.classList.add("dragging");
    let indicator = null;
    let lastDrop = null;

    function onMove(e) {
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      const y = e.clientY ?? e.touches?.[0]?.clientY;
      if (x === undefined || y === undefined) return;

      clearFeedback();
      lastDrop = findDropZone(x, y, cellId);
      if (!lastDrop) return;

      if (lastDrop.type === "swap") {
        const c = el.querySelector(`[data-cell-id="${lastDrop.targetCellId}"]`);
        if (c) c.classList.add("drop-target");
      } else if (lastDrop.type === "insert-before" || lastDrop.type === "insert-after") {
        const c = el.querySelector(`[data-cell-id="${lastDrop.targetCellId}"]`);
        if (c) showIndicator(c, lastDrop.type === "insert-before" ? "left" : "right");
      } else if (lastDrop.type === "new-row") {
        showRowIndicator();
      }
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
      widgetEl.classList.remove("dragging");
      clearFeedback();

      if (lastDrop) {
        const snapshot = capturePositions();
        executeDrop(cellId, lastDrop);
        animateFlip(snapshot);
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);

    function clearFeedback() {
      el.querySelectorAll(".drop-target").forEach((e) => e.classList.remove("drop-target"));
      if (indicator) { indicator.remove(); indicator = null; }
    }

    function showIndicator(cellEl, side) {
      indicator = document.createElement("div");
      indicator.className = "helm-insert-indicator";
      const rect = cellEl.getBoundingClientRect();
      const dRect = el.getBoundingClientRect();
      indicator.style.cssText = `position:absolute;top:${rect.top - dRect.top}px;height:${rect.height}px;left:${side === "left" ? rect.left - dRect.left - 2 : rect.right - dRect.left - 2}px;width:4px`;
      el.appendChild(indicator);
    }

    function showRowIndicator() {
      indicator = document.createElement("div");
      indicator.className = "helm-insert-indicator helm-insert-row";
      const btn = el.querySelector(".helm-add-row");
      if (btn) {
        const r = btn.getBoundingClientRect();
        const d = el.getBoundingClientRect();
        indicator.style.cssText = `position:absolute;top:${r.top - d.top - 2}px;left:4px;right:4px;height:4px;width:auto`;
      }
      el.appendChild(indicator);
    }
  }

  function findDropZone(x, y, excludeId) {
    for (const cellEl of el.querySelectorAll(".helm-dash-cell")) {
      if (cellEl.dataset.cellId === excludeId) continue;
      const r = cellEl.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;

      const rowId = cellEl.parentElement?.dataset.rowId;
      const row = layout.rows.find((r) => r.id === rowId);
      const relX = (x - r.left) / r.width;

      if (relX < 0.2 && row && row.cells.length < 4) {
        return { type: "insert-before", targetCellId: cellEl.dataset.cellId, targetRowId: rowId };
      } else if (relX > 0.8 && row && row.cells.length < 4) {
        return { type: "insert-after", targetCellId: cellEl.dataset.cellId, targetRowId: rowId };
      } else {
        return { type: "swap", targetCellId: cellEl.dataset.cellId };
      }
    }

    const addBtn = el.querySelector(".helm-add-row");
    if (addBtn) {
      const r = addBtn.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top - 20 && y <= r.bottom) {
        return { type: "new-row" };
      }
    }
    return null;
  }

  function executeDrop(srcId, drop) {
    let srcCell, srcRow, srcIdx;
    for (const row of layout.rows) {
      const i = row.cells.findIndex((c) => c.id === srcId);
      if (i !== -1) { srcCell = row.cells[i]; srcRow = row; srcIdx = i; break; }
    }
    if (!srcCell) return;

    if (drop.type === "swap") {
      let tRow, tIdx;
      for (const row of layout.rows) {
        const i = row.cells.findIndex((c) => c.id === drop.targetCellId);
        if (i !== -1) { tRow = row; tIdx = i; break; }
      }
      if (!tRow) return;
      const tCell = tRow.cells[tIdx];
      srcRow.cells[srcIdx] = tCell;
      tRow.cells[tIdx] = srcCell;
    } else if (drop.type === "insert-before" || drop.type === "insert-after") {
      srcRow.cells.splice(srcIdx, 1);
      const tRow = layout.rows.find((r) => r.id === drop.targetRowId);
      if (!tRow) return;
      const tIdx = tRow.cells.findIndex((c) => c.id === drop.targetCellId);
      if (tIdx === -1) return;
      tRow.cells.splice(drop.type === "insert-before" ? tIdx : tIdx + 1, 0, srcCell);
      redistribute(tRow);
      if (srcRow.cells.length > 0 && srcRow !== tRow) redistribute(srcRow);
      if (srcRow.cells.length === 0) layout.rows = layout.rows.filter((r) => r.id !== srcRow.id);
    } else if (drop.type === "new-row") {
      srcRow.cells.splice(srcIdx, 1);
      if (srcRow.cells.length === 0) layout.rows = layout.rows.filter((r) => r.id !== srcRow.id);
      layout.rows.push({ id: genId(), height: null, cells: [srcCell] });
    }

    notifyChange();
    render();
  }

  // --- FLIP animation ---

  function capturePositions() {
    const pos = new Map();
    for (const [cellId, widgetEl] of widgetEls) {
      if (widgetEl.offsetParent !== null) pos.set(cellId, widgetEl.getBoundingClientRect());
    }
    return pos;
  }

  function animateFlip(oldPos) {
    for (const [cellId, widgetEl] of widgetEls) {
      const old = oldPos.get(cellId);
      if (!old || widgetEl.offsetParent === null) continue;

      const cur = widgetEl.getBoundingClientRect();
      const dx = old.left - cur.left;
      const dy = old.top - cur.top;
      const sx = old.width / (cur.width || 1);
      const sy = old.height / (cur.height || 1);

      if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;

      widgetEl.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      widgetEl.style.transformOrigin = "top left";
      widgetEl.style.transition = "none";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          widgetEl.style.transition = "transform 0.25s cubic-bezier(0.2, 0, 0, 1)";
          widgetEl.style.transform = "";
          widgetEl.addEventListener("transitionend", function cleanup() {
            widgetEl.removeEventListener("transitionend", cleanup);
            widgetEl.style.transition = "";
            widgetEl.style.transformOrigin = "";
          }, { once: true });
        });
      });
    }
  }

  // --- Helpers ---

  function redistribute(row) { for (const c of row.cells) c.width = null; }
  function notifyChange() { if (onLayoutChange) onLayoutChange(layout); }

  function getLayout() { return layout; }
  function getWidget(cellId) { return widgets.get(cellId); }

  function unmount() {
    for (const [, w] of widgets) { try { w.unmount(); } catch {} }
    widgets.clear();
    widgetEls.clear();
    el.innerHTML = "";
  }

  // Initial render
  render();

  return { render, addRow, addCell, removeCell, setCellWidget, getLayout, getWidget, unmount };
}

function genId() { return Math.random().toString(36).slice(2, 10); }
