/**
 * Tala Notes Panel — Client-side component for the katulong-tala plugin.
 *
 * Renders a notes list + editor inside katulong's panel system.
 * Uses the plugin API context for REST calls to the tala connector.
 */

let container = null;
let ctx = null;
let currentNote = null;
let notes = [];
let editor = null;
let dirty = false;
let saveTimer = null;

const AUTOSAVE_DELAY = 1000;

export function mount(el, pluginCtx) {
  container = el;
  ctx = pluginCtx;
  render();
  loadNotes();
}

export function unmount() {
  if (saveTimer) clearTimeout(saveTimer);
  container = null;
  ctx = null;
}

export function focus() {
  if (editor) editor.focus();
}

function render() {
  container.innerHTML = `
    <div class="tala-layout">
      <div class="tala-sidebar">
        <div class="tala-sidebar-header">
          <span class="tala-title">Notes</span>
          <button class="tala-btn tala-btn-new" title="New note">
            <i class="ph ph-plus"></i>
          </button>
        </div>
        <div class="tala-note-list"></div>
      </div>
      <div class="tala-editor-area">
        <div class="tala-editor-header">
          <span class="tala-editor-path"></span>
          <span class="tala-editor-status"></span>
        </div>
        <textarea class="tala-editor" placeholder="Select or create a note..." spellcheck="false"></textarea>
      </div>
    </div>
  `;

  // Apply styles
  const style = document.createElement("style");
  style.dataset.talaPanelStyles = "";
  style.textContent = panelCSS;
  container.appendChild(style);

  // Wire events
  container.querySelector(".tala-btn-new").addEventListener("click", createNote);
  editor = container.querySelector(".tala-editor");
  editor.addEventListener("input", onEditorInput);
}

async function loadNotes() {
  try {
    const data = await ctx.api("GET", "/tala/api/notes");
    notes = data.notes || [];
    renderNoteList();
  } catch (err) {
    console.error("Failed to load notes:", err);
  }
}

function renderNoteList() {
  const list = container.querySelector(".tala-note-list");
  if (!list) return;

  if (notes.length === 0) {
    list.innerHTML = '<div class="tala-empty">No notes yet</div>';
    return;
  }

  list.innerHTML = notes.map(n => {
    const name = n.path.replace(/\.md$/, "");
    const active = currentNote === n.path ? " tala-note-active" : "";
    const date = new Date(n.modifiedAt).toLocaleDateString();
    return `
      <div class="tala-note-item${active}" data-path="${escapeAttr(n.path)}">
        <span class="tala-note-name">${escapeHtml(name)}</span>
        <span class="tala-note-date">${date}</span>
        <button class="tala-note-delete" data-path="${escapeAttr(n.path)}" title="Delete">
          <i class="ph ph-trash"></i>
        </button>
      </div>
    `;
  }).join("");

  // Click handlers
  for (const item of list.querySelectorAll(".tala-note-item")) {
    item.addEventListener("click", (e) => {
      if (e.target.closest(".tala-note-delete")) return;
      openNote(item.dataset.path);
    });
  }
  for (const btn of list.querySelectorAll(".tala-note-delete")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNote(btn.dataset.path);
    });
  }
}

async function openNote(path) {
  // Save current note first
  if (dirty && currentNote) {
    await saveCurrentNote();
  }

  try {
    const data = await ctx.api("GET", `/tala/api/notes/${encodeURIComponent(path)}`);
    currentNote = path;
    editor.value = data.content || "";
    dirty = false;
    updateEditorHeader();
    renderNoteList();
    editor.focus();

  } catch (err) {
    ctx.showToast(`Failed to open note: ${err.message}`);
  }
}

async function createNote() {
  const name = prompt("Note name:");
  if (!name) return;

  const path = name.endsWith(".md") ? name : name + ".md";
  try {
    await ctx.api("PUT", `/tala/api/notes/${encodeURIComponent(path)}`, {
      content: "",
      message: `Create ${path}`,
    });
    await loadNotes();
    openNote(path);
  } catch (err) {
    ctx.showToast(`Failed to create note: ${err.message}`);
  }
}

async function deleteNote(path) {
  if (!confirm(`Delete ${path}?`)) return;
  try {
    await ctx.api("DELETE", `/tala/api/notes/${encodeURIComponent(path)}`);
    if (currentNote === path) {
      currentNote = null;
      editor.value = "";
      dirty = false;
      updateEditorHeader();
    }
    await loadNotes();
  } catch (err) {
    ctx.showToast(`Failed to delete note: ${err.message}`);
  }
}

function onEditorInput() {
  dirty = true;
  updateEditorHeader();

  // Autosave with debounce
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrentNote(), AUTOSAVE_DELAY);

}

async function saveCurrentNote() {
  if (!currentNote || !dirty) return;
  dirty = false;
  updateEditorHeader();

  try {
    await ctx.api("PUT", `/tala/api/notes/${encodeURIComponent(currentNote)}`, {
      content: editor.value,
    });
  } catch (err) {
    dirty = true;
    updateEditorHeader();
    console.error("Save failed:", err);
  }
}

function updateEditorHeader() {
  const pathEl = container.querySelector(".tala-editor-path");
  const statusEl = container.querySelector(".tala-editor-status");
  if (pathEl) pathEl.textContent = currentNote ? currentNote.replace(/\.md$/, "") : "";
  if (statusEl) statusEl.textContent = dirty ? "Unsaved" : "";
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const panelCSS = `
  .tala-layout {
    display: flex;
    height: 100%;
    width: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
  }

  .tala-sidebar {
    width: 240px;
    min-width: 200px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .tala-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
  }

  .tala-title {
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 11px;
  }

  .tala-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 14px;
  }

  .tala-btn:hover {
    background: var(--accent);
    color: var(--text);
  }

  .tala-note-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .tala-note-item {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 12px;
    gap: 8px;
  }

  .tala-note-item:hover {
    background: var(--accent);
  }

  .tala-note-active {
    background: var(--accent);
    border-left: 2px solid var(--accent-active);
  }

  .tala-note-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tala-note-date {
    color: var(--text-dim);
    font-size: 10px;
    white-space: nowrap;
  }

  .tala-note-delete {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 2px;
    opacity: 0;
    transition: opacity 0.15s;
    font-size: 12px;
  }

  .tala-note-item:hover .tala-note-delete {
    opacity: 1;
  }

  .tala-note-delete:hover {
    color: var(--danger);
  }

  .tala-empty {
    padding: 16px 12px;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
  }

  .tala-editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .tala-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    min-height: 36px;
  }

  .tala-editor-path {
    color: var(--text);
    font-weight: 500;
  }

  .tala-editor-status {
    color: var(--warning);
    font-size: 11px;
  }

  .tala-editor {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: none;
    padding: 12px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    resize: none;
    outline: none;
    tab-size: 2;
  }

  .tala-editor::placeholder {
    color: var(--text-dim);
  }

  @media (max-width: 600px) {
    .tala-sidebar {
      width: 100%;
      min-width: 0;
    }
    .tala-layout {
      flex-direction: column;
    }
    .tala-sidebar {
      max-height: 200px;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
  }
`;
