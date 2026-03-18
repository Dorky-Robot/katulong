/**
 * Per-Tab Floating Notepad
 *
 * A Notion-style block editor that floats over the terminal.
 * Each session tab gets its own note, persisted as markdown.
 * localStorage is used as a fast cache; the server (DATA_DIR/notes/)
 * is the source of truth and is synced on open/save.
 * Type markdown, press Enter, and the line renders as rich text.
 * Click a rendered block to edit its markdown source.
 */

import { api } from "/lib/api-client.js";

const STORAGE_KEY_PREFIX = "katulong-notes-";
const POS_KEY = "katulong-notepad-pos";
const SIZE_KEY = "katulong-notepad-size";

/** Load from localStorage (fast cache) */
function loadNoteCache(sessionName) {
  try {
    return localStorage.getItem(STORAGE_KEY_PREFIX + sessionName) || "";
  } catch { return ""; }
}

/** Save to localStorage cache */
function saveNoteCache(sessionName, text) {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + sessionName, text);
  } catch { /* quota */ }
}

/** Load from server, falling back to cache */
async function loadNoteFromServer(sessionName) {
  try {
    const data = await api.get(`/api/notes/${encodeURIComponent(sessionName)}`);
    const content = data?.content || "";
    saveNoteCache(sessionName, content);
    return content;
  } catch {
    return loadNoteCache(sessionName);
  }
}

/** Save to server + cache */
async function saveNoteToServer(sessionName, text) {
  saveNoteCache(sessionName, text);
  try {
    await api.put(`/api/notes/${encodeURIComponent(sessionName)}`, { content: text });
  } catch { /* will retry on next save */ }
}

/** Delete from server + cache */
async function deleteNoteFromServer(sessionName) {
  try { localStorage.removeItem(STORAGE_KEY_PREFIX + sessionName); } catch {}
  try {
    await api.delete(`/api/notes/${encodeURIComponent(sessionName)}`);
  } catch { /* ignore */ }
}

function loadPos() {
  try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch { return null; }
}
function savePos(x, y) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch {}
}
function loadSize() {
  try { return JSON.parse(localStorage.getItem(SIZE_KEY)); } catch { return null; }
}
function saveSize(w, h) {
  try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h })); } catch {}
}

// ── Markdown rendering ──────────────────────────────────────────────

/** Escape HTML entities */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Parse inline markdown → HTML */
function inlineToHtml(text) {
  let h = esc(text);
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/__(.+?)__/g, "<b>$1</b>");
  h = h.replace(/\*(.+?)\*/g, "<i>$1</i>");
  h = h.replace(/_(.+?)_/g, "<i>$1</i>");
  h = h.replace(/~~(.+?)~~/g, "<s>$1</s>");
  h = h.replace(/`(.+?)`/g, "<code>$1</code>");
  return h;
}

/**
 * Render a single markdown line to an HTML string.
 * Returns { html, className } for the block element.
 */
function renderLine(line) {
  // Heading
  const hm = line.match(/^(#{1,3})\s+(.+)$/);
  if (hm) return { html: inlineToHtml(hm[2]), className: `np-h${hm[1].length}` };

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return { html: "<hr>", className: "np-hr" };

  // Checkbox
  const cbm = line.match(/^-\s*\[([ xX]?)\]\s+(.*)$/);
  if (cbm) {
    const checked = cbm[1].toLowerCase() === "x";
    return {
      html: `<span class="np-cb ${checked ? "np-cb-checked" : ""}"><i class="ph ph-${checked ? "check-square" : "square"}"></i></span> ${inlineToHtml(cbm[2])}`,
      className: "np-checklist" + (checked ? " np-checked" : ""),
    };
  }

  // Unordered list
  const ulm = line.match(/^[-*]\s+(.+)$/);
  if (ulm) return { html: `<span class="np-bullet"></span>${inlineToHtml(ulm[1])}`, className: "np-ul" };

  // Ordered list
  const olm = line.match(/^(\d+)\.\s+(.+)$/);
  if (olm) return { html: `<span class="np-num">${esc(olm[1])}.</span>${inlineToHtml(olm[2])}`, className: "np-ol" };

  // Blockquote
  const bqm = line.match(/^>\s+(.+)$/);
  if (bqm) return { html: inlineToHtml(bqm[1]), className: "np-bq" };

  // Code block (single line for now — ```code```)
  if (line.startsWith("```") && line.endsWith("```") && line.length > 6) {
    return { html: `<code>${esc(line.slice(3, -3))}</code>`, className: "np-code-block" };
  }

  // Plain paragraph with inline formatting
  return { html: inlineToHtml(line), className: "np-p" };
}

/** Count leading indent level (every 2 spaces = 1 level) */
function indentLevel(line) {
  const m = line.match(/^(\s*)/);
  return m ? Math.floor(m[1].length / 2) : 0;
}


/**
 * Create the floating notepad.
 */
export function createNotepad({ onClose }) {
  let currentSession = null;
  let el = null;
  let blocksEl = null;   // container for blocks
  let blocks = [];       // array of { md: string } — one per line
  let editingIdx = -1;   // index of block being edited (-1 = none, blocks.length = new empty)
  let saveTimer = null;

  // ── Serialization ───────────────────────────────────────────────

  function serialize() {
    return blocks.map(b => b.md).join("\n");
  }

  function parse(text) {
    if (!text) return [{ md: "" }];
    const lines = text.split("\n");
    return lines.map(md => ({ md }));
  }

  function scheduleSave() {
    if (currentSession) saveNoteCache(currentSession, serialize());
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (currentSession) saveNoteToServer(currentSession, serialize());
    }, 1000);
  }

  // ── Block rendering ─────────────────────────────────────────────

  function renderBlocks() {
    blocksEl.innerHTML = "";

    blocks.forEach((block, idx) => {
      if (idx === editingIdx) {
        blocksEl.appendChild(createEditBlock(idx));
      } else {
        blocksEl.appendChild(createRenderedBlock(block, idx));
      }
    });

    // If editing beyond the last block (new line), add an edit block
    if (editingIdx === blocks.length) {
      blocks.push({ md: "" });
      blocksEl.appendChild(createEditBlock(editingIdx));
    }

    // Always show an "add" area at the bottom if not already editing last
    if (editingIdx !== blocks.length - 1) {
      const addArea = document.createElement("div");
      addArea.className = "np-add-area";
      addArea.addEventListener("click", () => {
        editingIdx = blocks.length;
        renderBlocks();
      });
      blocksEl.appendChild(addArea);
    }
  }

  function createRenderedBlock(block, idx) {
    const div = document.createElement("div");
    const trimmed = block.md.trim();

    const level = indentLevel(block.md);

    if (!trimmed) {
      div.className = "np-block np-empty";
      div.innerHTML = "<br>";
    } else {
      const { html, className } = renderLine(trimmed);
      div.className = `np-block ${className}`;
      div.innerHTML = html;
      if (level > 0) div.style.paddingLeft = (0.75 + level * 1.25) + "rem";

      // Toggle checkbox on click
      const cb = div.querySelector(".np-cb");
      if (cb) {
        cb.addEventListener("click", (e) => {
          e.stopPropagation();
          const wasChecked = block.md.match(/^-\s*\[([ xX])\]/);
          if (wasChecked) {
            const nowChecked = wasChecked[1].toLowerCase() === "x" ? " " : "x";
            block.md = block.md.replace(/^(-\s*\[)[ xX](\])/, `$1${nowChecked}$2`);
            scheduleSave();
            renderBlocks();
          }
        });
      }
    }

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "np-drag-handle";
    handle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
    handle.setAttribute("draggable", "true");
    handle.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      dragIdx = idx;
      div.classList.add("np-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-notepad-block", String(idx));
    });
    handle.addEventListener("dragend", (e) => {
      e.stopPropagation();
      div.classList.remove("np-dragging");
      dragIdx = -1;
      clearDropIndicators();
    });
    div.insertBefore(handle, div.firstChild);

    // Drop target
    div.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-notepad-block")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      const rect = div.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        div.classList.add("np-drag-over-top");
      } else {
        div.classList.add("np-drag-over-bottom");
      }
    });
    div.addEventListener("dragleave", (e) => {
      e.stopPropagation();
      div.classList.remove("np-drag-over-top", "np-drag-over-bottom");
    });
    div.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes("application/x-notepad-block")) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators();
      if (dragIdx === -1 || dragIdx === idx) return;
      const rect = div.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const insertBefore = e.clientY < mid;
      // Reorder blocks
      const [moved] = blocks.splice(dragIdx, 1);
      let targetIdx = idx;
      if (dragIdx < idx) targetIdx--; // adjust after removal
      if (!insertBefore) targetIdx++;
      blocks.splice(targetIdx, 0, moved);
      dragIdx = -1;
      scheduleSave();
      renderBlocks();
    });

    // Click to edit
    div.addEventListener("click", (e) => {
      if (e.target.closest(".np-drag-handle") || e.target.closest(".np-cb")) return;
      editingIdx = idx;
      renderBlocks();
    });

    return div;
  }

  let dragIdx = -1;

  function clearDropIndicators() {
    if (!blocksEl) return;
    blocksEl.querySelectorAll(".np-drag-over-top, .np-drag-over-bottom").forEach(el => {
      el.classList.remove("np-drag-over-top", "np-drag-over-bottom");
    });
  }

  function createEditBlock(idx) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "np-edit-input";
    input.value = blocks[idx]?.md || "";
    input.setAttribute("aria-label", "Edit block");
    input.placeholder = "Type markdown…";

    let handledByKey = false; // prevent blur from fighting with keydown

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        handledByKey = true;
        const val = input.value;
        commitEdit(idx, val);

        // Detect list prefix to auto-continue (preserving indent)
        const indent = val.match(/^(\s*)/)[1];
        const content = val.slice(indent.length);
        const ulMatch = content.match(/^([-*])\s+(.*)$/);
        const olMatch = content.match(/^(\d+)\.\s+(.*)$/);
        const cbMatch = content.match(/^-\s*\[[ xX]?\]\s+(.*)$/);

        let nextPrefix = "";
        if (cbMatch) {
          if (!cbMatch[1].trim()) { blocks[idx].md = ""; }
          else nextPrefix = indent + "- [ ] ";
        } else if (ulMatch) {
          if (!ulMatch[2].trim()) { blocks[idx].md = ""; }
          else nextPrefix = indent + ulMatch[1] + " ";
        } else if (olMatch) {
          if (!olMatch[2].trim()) { blocks[idx].md = ""; }
          else nextPrefix = indent + (parseInt(olMatch[1]) + 1) + ". ";
        }

        // Always insert a new block after the current one
        editingIdx = idx + 1;
        blocks.splice(editingIdx, 0, { md: nextPrefix });
        renderBlocks();
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        const pos = input.selectionStart;
        if (e.shiftKey) {
          // Shift+Tab: remove up to 2 leading spaces
          const m = input.value.match(/^( {1,2})/);
          if (m) {
            input.value = input.value.slice(m[1].length);
            input.selectionStart = input.selectionEnd = Math.max(0, pos - m[1].length);
          }
        } else {
          // Tab: add 2 spaces at start
          input.value = "  " + input.value;
          input.selectionStart = input.selectionEnd = pos + 2;
        }
        if (blocks[idx]) blocks[idx].md = input.value;
        scheduleSave();
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        handledByKey = true;
        // Revert: if empty and it was a new block, remove it
        if (!input.value.trim() && idx === blocks.length - 1 && !blocks[idx]?.md) {
          blocks.pop();
        }
        editingIdx = -1;
        renderBlocks();
        return;
      }

      if (e.key === "Backspace" && input.value === "" && idx > 0) {
        e.preventDefault();
        handledByKey = true;
        blocks.splice(idx, 1);
        editingIdx = idx - 1;
        scheduleSave();
        renderBlocks();
        return;
      }

      if (e.key === "ArrowUp" && idx > 0) {
        e.preventDefault();
        handledByKey = true;
        commitEdit(idx, input.value);
        editingIdx = idx - 1;
        renderBlocks();
        return;
      }

      if (e.key === "ArrowDown" && idx < blocks.length - 1) {
        e.preventDefault();
        handledByKey = true;
        commitEdit(idx, input.value);
        editingIdx = idx + 1;
        renderBlocks();
        return;
      }
    });

    // Save on every keystroke (debounced)
    input.addEventListener("input", () => {
      if (blocks[idx]) blocks[idx].md = input.value;
      scheduleSave();
    });

    // Blur: commit and deselect (only if not already handled by a key)
    input.addEventListener("blur", () => {
      if (handledByKey) return;
      commitEdit(idx, input.value);
      // Clean up trailing empty blocks
      while (blocks.length > 1 && !blocks[blocks.length - 1].md.trim()) {
        blocks.pop();
      }
      editingIdx = -1;
      scheduleSave();
      renderBlocks();
    });

    // Auto-focus (double-rAF ensures DOM is fully laid out)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (input.isConnected) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }));

    const wrapper = document.createElement("div");
    wrapper.className = "np-block np-editing";
    wrapper.appendChild(input);
    return wrapper;
  }

  function commitEdit(idx, value) {
    if (blocks[idx]) {
      blocks[idx].md = value;
    }
    scheduleSave();
  }

  // ── Help panel ──────────────────────────────────────────────────

  let helpVisible = false;

  function toggleHelp() {
    helpVisible = !helpVisible;
    if (!helpVisible) {
      // Show blocks, hide help
      blocksEl.style.display = "";
      const existing = el?.querySelector(".np-help");
      if (existing) existing.remove();
      return;
    }

    // Hide blocks, show help in their place
    blocksEl.style.display = "none";

    const help = document.createElement("div");
    help.className = "np-help";
    help.innerHTML = [
      "<b>Markdown cheat sheet</b>",
      "",
      "<code># Heading 1</code>",
      "<code>## Heading 2</code>",
      "<code>### Heading 3</code>",
      "",
      "<code>- item</code> or <code>* item</code> &rarr; bullet list",
      "<code>1. item</code> &rarr; numbered list",
      "<code>- [] task</code> or <code>- [x] done</code> &rarr; checkbox",
      "<code>> quote</code> &rarr; blockquote",
      "<code>---</code> &rarr; divider",
      "",
      "<code>**bold**</code>  <code>*italic*</code>",
      "<code>~~strike~~</code>  <code>`code`</code>",
      "",
      "<b>Keys</b>",
      "",
      "<code>Enter</code> commit line &amp; continue",
      "<code>Tab</code> / <code>Shift+Tab</code> indent / outdent",
      "<code>&uarr;</code> / <code>&darr;</code> navigate blocks",
      "<code>Esc</code> stop editing",
      "<code>Backspace</code> on empty &rarr; delete block",
      "Drag <code>&#x2807;</code> handle to reorder",
    ].join("<br>");
    blocksEl.after(help);
  }

  // ── Build DOM ───────────────────────────────────────────────────

  function build() {
    el = document.createElement("div");
    el.id = "notepad";
    el.className = "notepad";

    const size = loadSize();
    if (size) {
      el.style.width = size.w + "px";
      el.style.height = size.h + "px";
    }

    // Title bar
    const titleBar = document.createElement("div");
    titleBar.className = "notepad-titlebar";

    const titleLabel = document.createElement("span");
    titleLabel.className = "notepad-title";
    titleLabel.innerHTML = '<i class="ph ph-note-pencil"></i> Notes';
    titleBar.appendChild(titleLabel);

    const titleBtns = document.createElement("span");
    titleBtns.className = "notepad-title-btns";

    const helpBtn = document.createElement("button");
    helpBtn.className = "notepad-close";
    helpBtn.setAttribute("aria-label", "Markdown help");
    helpBtn.innerHTML = '<i class="ph ph-question"></i>';
    helpBtn.addEventListener("click", () => toggleHelp());
    titleBtns.appendChild(helpBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "notepad-close";
    closeBtn.setAttribute("aria-label", "Close notepad");
    closeBtn.innerHTML = '<i class="ph ph-x"></i>';
    closeBtn.addEventListener("click", () => hide());
    titleBtns.appendChild(closeBtn);

    titleBar.appendChild(titleBtns);

    el.appendChild(titleBar);

    // Blocks container
    blocksEl = document.createElement("div");
    blocksEl.className = "notepad-blocks";
    // Prevent internal block drags from triggering the global image drop overlay
    for (const evt of ["dragenter", "dragleave", "dragover", "drop"]) {
      blocksEl.addEventListener(evt, (e) => {
        if (dragIdx !== -1) e.stopPropagation();
      });
    }
    el.appendChild(blocksEl);

    // Resize handle
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "notepad-resize";
    resizeHandle.innerHTML = '<i class="ph ph-arrows-out-simple"></i>';
    setupResize(resizeHandle);
    el.appendChild(resizeHandle);

    setupDrag(titleBar);
    return el;
  }

  // ── Drag ────────────────────────────────────────────────────────

  function setupDrag(handle) {
    let dragState = null;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      dragState = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };

      const onMove = (me) => {
        const m = 8;
        const vw = window.visualViewport?.width ?? window.innerWidth;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        let x = me.clientX - dragState.ox;
        let y = me.clientY - dragState.oy;
        x = Math.max(m, Math.min(x, vw - el.offsetWidth - m));
        y = Math.max(m, Math.min(y, vh - el.offsetHeight - m));
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        savePos(parseInt(el.style.left), parseInt(el.style.top));
        dragState = null;
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    handle.addEventListener("touchstart", (e) => {
      if (e.target.closest("button")) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const rect = el.getBoundingClientRect();
      dragState = { ox: t.clientX - rect.left, oy: t.clientY - rect.top };
    }, { passive: true });

    handle.addEventListener("touchmove", (e) => {
      if (!dragState) return;
      e.preventDefault();
      const t = e.touches[0];
      const m = 8;
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      let x = t.clientX - dragState.ox;
      let y = t.clientY - dragState.oy;
      x = Math.max(m, Math.min(x, vw - el.offsetWidth - m));
      y = Math.max(m, Math.min(y, vh - el.offsetHeight - m));
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    }, { passive: false });

    handle.addEventListener("touchend", () => {
      if (dragState) {
        savePos(parseInt(el.style.left), parseInt(el.style.top));
        dragState = null;
      }
    });
  }

  // ── Resize ──────────────────────────────────────────────────────

  function setupResize(handle) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;
      const onMove = (me) => {
        el.style.width = Math.max(240, startW + (me.clientX - startX)) + "px";
        el.style.height = Math.max(180, startH + (me.clientY - startY)) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        saveSize(el.offsetWidth, el.offsetHeight);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    handle.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const startX = t.clientX, startY = t.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;
      const onMove = (te) => {
        te.preventDefault();
        const touch = te.touches[0];
        el.style.width = Math.max(240, startW + (touch.clientX - startX)) + "px";
        el.style.height = Math.max(180, startH + (touch.clientY - startY)) + "px";
      };
      const onEnd = () => {
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        saveSize(el.offsetWidth, el.offsetHeight);
      };
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
    }, { passive: true });
  }

  // ── Position ────────────────────────────────────────────────────

  function positionElement() {
    const saved = loadPos();
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      el.style.left = saved.x + "px";
      el.style.top = saved.y + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    } else {
      el.style.right = "1rem";
      el.style.bottom = "1rem";
    }
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const m = 8;
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      if (rect.right > vw - m || rect.bottom > vh - m || rect.left < m || rect.top < m) {
        const x = Math.max(m, Math.min(rect.left, vw - rect.width - m));
        const y = Math.max(m, Math.min(rect.top, vh - rect.height - m));
        el.style.left = x + "px";
        el.style.top = y + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
    });
  }

  // ── Show / Hide ─────────────────────────────────────────────────

  function show(sessionName) {
    currentSession = sessionName;

    if (!el) {
      build();
      document.body.appendChild(el);
    }

    // Show immediately with cached data, then refresh from server
    blocks = parse(loadNoteCache(sessionName));
    editingIdx = -1;
    renderBlocks();

    const island = document.getElementById("key-island");
    if (island) island.style.display = "none";

    el.style.display = "flex";
    positionElement();

    // Async load from server (updates if different)
    _syncFromServer(sessionName);
    // Poll for external changes (e.g. CLI edits) while visible
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(() => {
      if (currentSession && isActive() && editingIdx === -1) {
        _syncFromServer(currentSession);
      }
    }, 3000);
  }

  let _syncTimer = null;

  function _syncFromServer(sessionName) {
    loadNoteFromServer(sessionName).then(content => {
      if (currentSession === sessionName && content !== serialize()) {
        blocks = parse(content);
        editingIdx = -1;
        renderBlocks();
      }
    });
  }

  function hide() {
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (currentSession) saveNoteToServer(currentSession, serialize());

    if (el) el.style.display = "none";

    const island = document.getElementById("key-island");
    if (island) island.style.display = "";

    if (onClose) onClose();
  }

  function isActive() {
    return el && el.style.display !== "none";
  }

  return {
    show,
    hide,
    isActive,

    async rename(oldName, newName) {
      const data = loadNoteCache(oldName);
      if (data) {
        saveNoteCache(newName, data);
        saveNoteToServer(newName, data);
      }
      deleteNoteFromServer(oldName);
      if (currentSession === oldName) currentSession = newName;
    },

    onSessionKilled(name) {
      // Notes persist even after session is killed — they're tied to
      // the tab name, not the tmux session lifecycle
      if (currentSession === name) hide();
    },

    hasNotes(sessionName) {
      return loadNoteCache(sessionName).trim().length > 0;
    },
  };
}
