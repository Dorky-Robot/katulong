/**
 * Notes Tile Renderer — flat-name markdown notes.
 *
 * Identity model: name = filename = the only handle. The tile holds a
 * stable `notes-<id>` tile id; the user-visible name lives in props
 * and is kept in lockstep with the file on disk via PATCH /api/notes/:name.
 *
 * Two display modes share one renderer:
 *   - props.name unset → picker (list existing + "New" button)
 *   - props.name set   → block-line markdown editor on that file
 *
 * The picker is the empty state of the tile. Once a note is opened or
 * created, `name` is dispatched into props (UPDATE_PROPS) so reload
 * reopens the same note. The renderer is not session-coupled.
 *
 * Auto-naming: after the first save of an `untitled-N` note with enough
 * content to summarize, /api/notes/auto-name asks the shared ollama
 * cascade for a slug. Only fires if the user has not manually renamed
 * the tile (props.userRenamed === true is the lock).
 */

import { api } from "../api-client.js";

// Mirrors lib/routes/app-routes.js:isValidNoteName — kept duplicated so
// the renderer can short-circuit obviously-bad rename input without a
// roundtrip. Server still validates authoritatively.
const VALID_NAME_RE = /^[A-Za-z0-9 _.\-()[\]]{1,120}$/;
function isValidNoteName(name) {
  if (typeof name !== "string") return false;
  if (!VALID_NAME_RE.test(name)) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(" ")) return false;
  if (name.includes("..")) return false;
  return true;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

function renderLine(line) {
  const hm = line.match(/^(#{1,3})\s+(.+)$/);
  if (hm) return { html: inlineToHtml(hm[2]), className: `np-h${hm[1].length}` };

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return { html: "<hr>", className: "np-hr" };

  const cbm = line.match(/^-\s*\[([ xX]?)\]\s+(.*)$/);
  if (cbm) {
    const checked = cbm[1].toLowerCase() === "x";
    return {
      html: `<span class="np-cb ${checked ? "np-cb-checked" : ""}"><i class="ph ph-${checked ? "check-square" : "square"}"></i></span> ${inlineToHtml(cbm[2])}`,
      className: "np-checklist" + (checked ? " np-checked" : ""),
    };
  }

  const ulm = line.match(/^[-*]\s+(.+)$/);
  if (ulm) return { html: `<span class="np-bullet"></span>${inlineToHtml(ulm[1])}`, className: "np-ul" };

  const olm = line.match(/^(\d+)\.\s+(.+)$/);
  if (olm) return { html: `<span class="np-num">${esc(olm[1])}.</span>${inlineToHtml(olm[2])}`, className: "np-ol" };

  const bqm = line.match(/^>\s+(.+)$/);
  if (bqm) return { html: inlineToHtml(bqm[1]), className: "np-bq" };

  if (line.startsWith("```") && line.endsWith("```") && line.length > 6) {
    return { html: `<code>${esc(line.slice(3, -3))}</code>`, className: "np-code-block" };
  }

  return { html: inlineToHtml(line), className: "np-p" };
}

function indentLevel(line) {
  const m = line.match(/^(\s*)/);
  return m ? Math.floor(m[1].length / 2) : 0;
}

function formatMtime(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "";
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const dayDiff = (now.getTime() - date.getTime()) / 86400000;
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString();
}

export const notesRenderer = {
  type: "notes",

  init(_deps) {},

  describe(props) {
    const name = (props && typeof props.name === "string") ? props.name : null;
    return {
      title: name || "Notes",
      icon: "note-pencil",
      // An empty picker has no useful state to restore — let it open
      // fresh on next boot rather than persisting an `untitled` view.
      // Once a name is set, the file backs persistence so the tile can
      // round-trip cleanly through localStorage.
      persistable: !!name,
      session: null,
      updatesUrl: false,
      renameable: !!name,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    let mounted = true;
    let currentName = (props && typeof props.name === "string") ? props.name : null;
    let userRenamed = !!(props && props.userRenamed);
    let blocks = [{ md: "" }];
    let editingIdx = -1;
    let saveTimer = null;
    let pollTimer = null;
    let dragIdx = -1;
    let autoNameTried = false;

    const root = document.createElement("div");
    root.className = "notes-tile-root";
    el.appendChild(root);

    let viewEl = null;       // current mode container (picker or editor)
    let blocksEl = null;     // editor's blocks container

    function teardownTimers() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function clearView() {
      teardownTimers();
      if (viewEl) viewEl.remove();
      viewEl = null;
      blocksEl = null;
    }

    // ── Picker mode ─────────────────────────────────────────────────

    function showPicker() {
      clearView();
      ctx.setTitle?.("Notes");
      ctx.setIcon?.("note-pencil");

      viewEl = document.createElement("div");
      viewEl.className = "notes-picker";

      const header = document.createElement("div");
      header.className = "notes-picker-header";
      const title = document.createElement("span");
      title.className = "notes-picker-title";
      title.textContent = "Open or create a note";
      const newBtn = document.createElement("button");
      newBtn.className = "notes-picker-new";
      newBtn.innerHTML = '<i class="ph ph-plus"></i> New';
      newBtn.addEventListener("click", () => createNew());
      header.appendChild(title);
      header.appendChild(newBtn);
      viewEl.appendChild(header);

      const listEl = document.createElement("div");
      listEl.className = "notes-picker-list";
      viewEl.appendChild(listEl);
      root.appendChild(viewEl);

      const loading = document.createElement("div");
      loading.className = "notes-picker-empty";
      loading.textContent = "Loading…";
      listEl.appendChild(loading);

      api.get("/api/notes").then((resp) => {
        if (!mounted || viewEl === null) return;
        const notes = (resp && Array.isArray(resp.notes)) ? resp.notes : [];
        listEl.innerHTML = "";
        if (notes.length === 0) {
          const empty = document.createElement("div");
          empty.className = "notes-picker-empty";
          empty.textContent = "No notes yet. Click New to create one.";
          listEl.appendChild(empty);
          return;
        }
        for (const note of notes) {
          const row = document.createElement("button");
          row.className = "notes-picker-row";
          const nameEl = document.createElement("span");
          nameEl.className = "notes-picker-row-name";
          nameEl.textContent = note.name;
          const mtimeEl = document.createElement("span");
          mtimeEl.className = "notes-picker-row-mtime";
          mtimeEl.textContent = formatMtime(note.mtime);
          row.appendChild(nameEl);
          row.appendChild(mtimeEl);
          row.addEventListener("click", () => openExisting(note.name));
          listEl.appendChild(row);
        }
      }).catch(() => {
        if (!mounted) return;
        listEl.innerHTML = "";
        const err = document.createElement("div");
        err.className = "notes-picker-empty";
        err.textContent = "Failed to load notes.";
        listEl.appendChild(err);
      });
    }

    async function createNew() {
      try {
        const resp = await api.post("/api/notes", {});
        if (!resp || typeof resp.name !== "string") throw new Error("Bad create response");
        // Server-assigned untitled-N is not a manual rename. Leave
        // userRenamed untouched so auto-naming can still kick in.
        commitNameSelection(resp.name, false);
      } catch (err) {
        console.error("[Notes] Create failed:", err);
      }
    }

    function openExisting(name) {
      // Selecting an existing note from the picker is also not a manual
      // rename — the user just chose which one to view.
      commitNameSelection(name, false);
    }

    function commitNameSelection(name, isManualRename) {
      currentName = name;
      autoNameTried = false;
      if (isManualRename) userRenamed = true;
      dispatch({
        type: "ui/UPDATE_PROPS",
        id,
        patch: { name, userRenamed: userRenamed || isManualRename },
      });
      showEditor(name);
    }

    // ── Editor mode ─────────────────────────────────────────────────

    function showEditor(name) {
      clearView();
      ctx.setTitle?.(name);
      ctx.setIcon?.("note-pencil");

      viewEl = document.createElement("div");
      viewEl.className = "notes-editor";

      const toolbar = document.createElement("div");
      toolbar.className = "notes-editor-toolbar";
      const backBtn = document.createElement("button");
      backBtn.className = "notes-editor-btn";
      backBtn.setAttribute("aria-label", "Back to notes list");
      backBtn.innerHTML = '<i class="ph ph-list"></i>';
      backBtn.addEventListener("click", () => returnToPicker());
      const helpBtn = document.createElement("button");
      helpBtn.className = "notes-editor-btn";
      helpBtn.setAttribute("aria-label", "Markdown help");
      helpBtn.innerHTML = '<i class="ph ph-question"></i>';
      helpBtn.addEventListener("click", () => toggleHelp());
      toolbar.appendChild(backBtn);
      toolbar.appendChild(helpBtn);
      viewEl.appendChild(toolbar);

      blocksEl = document.createElement("div");
      blocksEl.className = "notes-blocks";
      viewEl.appendChild(blocksEl);

      root.appendChild(viewEl);

      // Initial load
      api.get("/api/notes/" + encodeURIComponent(name)).then((resp) => {
        if (!mounted || currentName !== name) return;
        const content = (resp && typeof resp.content === "string") ? resp.content : "";
        blocks = parseBlocks(content);
        editingIdx = -1;
        renderBlocks();
      }).catch(() => {
        // Likely 404 (deleted externally). Drop back to picker.
        if (!mounted || currentName !== name) return;
        currentName = null;
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { name: null, userRenamed: false } });
        showPicker();
      });

      // Poll for external edits while we aren't actively typing.
      pollTimer = setInterval(() => {
        if (!mounted || currentName !== name || editingIdx !== -1) return;
        api.get("/api/notes/" + encodeURIComponent(currentName)).then((resp) => {
          if (!mounted || currentName !== name) return;
          const content = (resp && typeof resp.content === "string") ? resp.content : "";
          if (content !== serializeBlocks()) {
            blocks = parseBlocks(content);
            renderBlocks();
          }
        }).catch(() => { /* transient — try next tick */ });
      }, 3000);
    }

    function returnToPicker() {
      // Save any pending edits before switching modes — picker doesn't
      // know about the in-flight save timer.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (currentName) {
        api.put("/api/notes/" + encodeURIComponent(currentName), { content: serializeBlocks() })
          .catch(() => { /* will retry on next edit */ });
      }
      currentName = null;
      userRenamed = false;
      autoNameTried = false;
      dispatch({ type: "ui/UPDATE_PROPS", id, patch: { name: null, userRenamed: false } });
      showPicker();
    }

    function parseBlocks(text) {
      if (!text) return [{ md: "" }];
      return text.split("\n").map((md) => ({ md }));
    }

    function serializeBlocks() {
      return blocks.map((b) => b.md).join("\n");
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        if (!currentName) return;
        const content = serializeBlocks();
        try {
          await api.put("/api/notes/" + encodeURIComponent(currentName), { content });
        } catch (err) {
          console.error("[Notes] Save failed:", err);
          return;
        }
        maybeAutoName(content);
      }, 1000);
    }

    async function maybeAutoName(content) {
      if (autoNameTried) return;
      if (userRenamed) return;
      if (!currentName || !currentName.startsWith("untitled")) return;
      // Need real signal — tiny snippets produce useless slugs.
      if (content.replace(/\s+/g, "").length < 20) return;
      autoNameTried = true;
      try {
        const r = await api.post("/api/notes/auto-name", { content });
        const suggestion = r && typeof r.suggestion === "string" ? r.suggestion : null;
        if (!mounted) return;
        if (!suggestion) return;
        if (suggestion === currentName) return;
        // Re-check the lock: the user may have renamed manually while
        // ollama was thinking.
        if (userRenamed) return;
        if (!isValidNoteName(suggestion)) return;
        try {
          await api.patch("/api/notes/" + encodeURIComponent(currentName), { newName: suggestion });
        } catch {
          // 409 (collision) or 400 — leave the untitled name. User can
          // rename manually; auto-name will not retry on this tile.
          return;
        }
        currentName = suggestion;
        ctx.setTitle?.(suggestion);
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { name: suggestion } });
      } catch {
        // ollama unavailable — leave the door open for a later attempt
        // by clearing the flag. Editor will retry on the next save.
        autoNameTried = false;
      }
    }

    // ── Block rendering (ported from notepad.js, floating chrome stripped) ──

    function renderBlocks() {
      if (!blocksEl) return;
      blocksEl.innerHTML = "";

      blocks.forEach((block, idx) => {
        if (idx === editingIdx) {
          blocksEl.appendChild(createEditBlock(idx));
        } else {
          blocksEl.appendChild(createRenderedBlock(block, idx));
        }
      });

      if (editingIdx === blocks.length) {
        blocks.push({ md: "" });
        blocksEl.appendChild(createEditBlock(editingIdx));
      }

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

    function clearDropIndicators() {
      if (!blocksEl) return;
      blocksEl.querySelectorAll(".np-drag-over-top, .np-drag-over-bottom").forEach((node) => {
        node.classList.remove("np-drag-over-top", "np-drag-over-bottom");
      });
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

      const handle = document.createElement("span");
      handle.className = "np-drag-handle";
      handle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
      handle.setAttribute("draggable", "true");
      handle.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        dragIdx = idx;
        div.classList.add("np-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-notes-block", String(idx));
      });
      handle.addEventListener("dragend", (e) => {
        e.stopPropagation();
        div.classList.remove("np-dragging");
        dragIdx = -1;
        clearDropIndicators();
      });
      div.insertBefore(handle, div.firstChild);

      div.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/x-notes-block")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        clearDropIndicators();
        const rect = div.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (e.clientY < mid) div.classList.add("np-drag-over-top");
        else div.classList.add("np-drag-over-bottom");
      });
      div.addEventListener("dragleave", (e) => {
        e.stopPropagation();
        div.classList.remove("np-drag-over-top", "np-drag-over-bottom");
      });
      div.addEventListener("drop", (e) => {
        if (!e.dataTransfer.types.includes("application/x-notes-block")) return;
        e.preventDefault();
        e.stopPropagation();
        clearDropIndicators();
        if (dragIdx === -1 || dragIdx === idx) return;
        const rect = div.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const insertBefore = e.clientY < mid;
        const [moved] = blocks.splice(dragIdx, 1);
        let targetIdx = idx;
        if (dragIdx < idx) targetIdx--;
        if (!insertBefore) targetIdx++;
        blocks.splice(targetIdx, 0, moved);
        dragIdx = -1;
        scheduleSave();
        renderBlocks();
      });

      div.addEventListener("click", (e) => {
        if (e.target.closest(".np-drag-handle") || e.target.closest(".np-cb")) return;
        editingIdx = idx;
        renderBlocks();
      });

      return div;
    }

    function createEditBlock(idx) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "np-edit-input";
      input.value = blocks[idx]?.md || "";
      input.setAttribute("aria-label", "Edit block");
      input.placeholder = "Type markdown…";

      let handledByKey = false;

      input.addEventListener("keydown", (e) => {
        e.stopPropagation();

        if (e.key === "Enter") {
          e.preventDefault();
          handledByKey = true;
          const val = input.value;
          commitEdit(idx, val);

          const indent = val.match(/^(\s*)/)[1];
          const content = val.slice(indent.length);
          const ulMatch = content.match(/^([-*])\s+(.*)$/);
          const olMatch = content.match(/^(\d+)\.\s+(.*)$/);
          const cbMatch = content.match(/^-\s*\[[ xX]?\]\s+(.*)$/);

          let nextPrefix = "";
          if (cbMatch) {
            if (!cbMatch[1].trim()) blocks[idx].md = "";
            else nextPrefix = indent + "- [ ] ";
          } else if (ulMatch) {
            if (!ulMatch[2].trim()) blocks[idx].md = "";
            else nextPrefix = indent + ulMatch[1] + " ";
          } else if (olMatch) {
            if (!olMatch[2].trim()) blocks[idx].md = "";
            else nextPrefix = indent + (parseInt(olMatch[1]) + 1) + ". ";
          }

          editingIdx = idx + 1;
          blocks.splice(editingIdx, 0, { md: nextPrefix });
          renderBlocks();
          return;
        }

        if (e.key === "Tab") {
          e.preventDefault();
          const pos = input.selectionStart;
          if (e.shiftKey) {
            const m = input.value.match(/^( {1,2})/);
            if (m) {
              input.value = input.value.slice(m[1].length);
              input.selectionStart = input.selectionEnd = Math.max(0, pos - m[1].length);
            }
          } else {
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

      input.addEventListener("input", () => {
        if (blocks[idx]) blocks[idx].md = input.value;
        scheduleSave();
      });

      input.addEventListener("blur", () => {
        if (handledByKey) return;
        commitEdit(idx, input.value);
        while (blocks.length > 1 && !blocks[blocks.length - 1].md.trim()) {
          blocks.pop();
        }
        editingIdx = -1;
        scheduleSave();
        renderBlocks();
      });

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
      if (blocks[idx]) blocks[idx].md = value;
      scheduleSave();
    }

    function toggleHelp() {
      if (!viewEl) return;
      const existing = viewEl.querySelector(".np-help");
      if (existing) {
        existing.remove();
        if (blocksEl) blocksEl.style.display = "";
        return;
      }
      if (blocksEl) blocksEl.style.display = "none";
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
      viewEl.appendChild(help);
    }

    // ── Boot ────────────────────────────────────────────────────────

    if (currentName) showEditor(currentName);
    else showPicker();

    return {
      unmount() {
        mounted = false;
        clearView();
        el.innerHTML = "";
      },
      focus() {},
      blur() {},
      resize() {},
      getSessions() { return []; },
      // Tile escape hatch — app.js's tab-rename listener calls setName
      // for renameable session-less tiles. Returns true if applied.
      tile: {
        async setName(newName) {
          if (!mounted) return false;
          if (!currentName) return false;
          if (newName === currentName) return false;
          if (!isValidNoteName(newName)) return false;
          try {
            await api.patch("/api/notes/" + encodeURIComponent(currentName), { newName });
          } catch (err) {
            console.error("[Notes] Rename failed:", err);
            return false;
          }
          currentName = newName;
          userRenamed = true;
          ctx.setTitle?.(newName);
          dispatch({
            type: "ui/UPDATE_PROPS",
            id,
            patch: { name: newName, userRenamed: true },
          });
          return true;
        },
      },
    };
  },
};
