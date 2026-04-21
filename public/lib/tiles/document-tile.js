/**
 * Document Tile
 *
 * Two modes:
 *   - File-backed: given a filePath, fetches content from /api/files/read
 *     on mount. Code files open in CodeMirror 6 with syntax highlighting
 *     and save support (Cmd+S / Ctrl+S). Persistable — re-fetches on restore.
 *   - Content-backed: given title + content + format directly. Not
 *     persistable (content too large for localStorage).
 *
 * Markdown files (.md ext or format: "markdown") are rendered as HTML
 * via vendored marked.js. All other formats render in CodeMirror.
 *
 * File-backed tiles subscribe to /api/files/watch via createDocumentWatcher
 * so the view auto-syncs with on-disk changes. For markdown the re-render
 * is silent; for the code editor a VSCode-style conflict banner appears
 * when the user has unsaved edits — they choose Revert (load disk) or
 * Overwrite (save their buffer).
 */

import { api } from "/lib/api-client.js";
import { marked } from "/vendor/marked/marked.esm.js";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";
import { createDocumentWatcher } from "/lib/document-watcher.js";

/* ---------- cute animated error pages ---------- */

// Each entry has `frames` (array of ASCII art strings cycled on a timer)
// and `ms` (frame duration). Omit `ms` to use the default (400ms).

const NOT_FOUND_PAGES = [
  { frames: ["(o_O)", "(O_o)", "(o_O)", "(O_o)", "(o_o)", "(o_o)"], ms: 500,
    msg: "This file is playing hide and seek. It's winning." },
  { frames: ["(;-;)", "(;_;)", "(; ;)", "(;_;)"], ms: 600,
    msg: "File not found. It was here a second ago, I swear." },
  { frames: ["\\(o.o)/", "\\(o.o)>", "\\(o.o)/", "<(o.o)/"], ms: 350,
    msg: "Gone. Poof. Like it was never here." },
  { frames: ["(-_-)", "(-_-)", "(-_-)", "(- -)", "(-_-)", "(-_-)"], ms: 800,
    msg: "The file has left the building." },
  { frames: ["(x_x)", "(x_x)", "(X_X)", "(x_x)"], ms: 900,
    msg: "This file exists only in the realm of imagination." },
  { frames: ["(?.?)", "(?_?)", "(?.?)", "(?-?)"], ms: 700,
    msg: "Are you sure that's the right path?" },
  { frames: ["(@_@)", "(@.@)", "(@_@)", "(@-@)"], ms: 500,
    msg: "Looked everywhere. Under the couch, behind the fridge. Nope." },
  { frames: ["(~_~)", "(~.~)", "(~_~)", "(~-~)", "(~_~)", "(- -)"], ms: 800,
    msg: "File's on vacation. Did not leave a forwarding address." },
  { frames: ["(>.<)", "(>_<)", "(>.<)", "(>.<)", "(>.>)"], ms: 600,
    msg: "So close, yet so 404." },
  { frames: ["(._.)", "(._. )", "( ._.)", "(._.)", "(._.)", "(-_-)"], ms: 500,
    msg: "This path leads nowhere. Philosophically and literally." },
];

const ERROR_PAGES = {
  403: [
    { frames: ["(#_#)", "(#.#)", "(#_#)", "(#-#)"], ms: 600,
      msg: "Permission denied. This file has boundaries." },
    { frames: ["(o_o)b", "(o_o)d", "(o_o)b", "(o_o)d"], ms: 500,
      msg: "You shall not read! (Access denied.)" },
  ],
  413: [
    { frames: ["(O_O)", "(O O)", "(O_O)", "(O_O)", "(O_O)", "(o_o)"], ms: 700,
      msg: "This file is too chonky to display inline." },
  ],
  415: [
    { frames: ["[bin]", "[BIN]", "[bin]", "[b1n]", "[bin]"], ms: 400,
      msg: "Binary file. All zeroes and ones, no letters." },
  ],
};

const GENERIC_FRAMES = ["(x_x)", "(x_x)", "(X_X)", "(x_x)", "(x_x)", "(+_+)"];

function parseStatusCode(errMsg) {
  const m = errMsg.match(/\((\d{3})\)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Start an ASCII animation loop on an element.
 * Returns a cleanup function that stops the interval.
 */
function animateArt(el, frames, ms) {
  if (!frames || frames.length <= 1) return () => {};
  let i = 0;
  const id = setInterval(() => {
    i = (i + 1) % frames.length;
    el.textContent = frames[i];
  }, ms || 400);
  return () => clearInterval(id);
}

/**
 * Render a styled error page inside `parentEl` with a retry button.
 * @param {HTMLElement} parentEl - container to fill
 * @param {Error} err - the fetch error
 * @param {string} filePath - path that failed
 * @param {() => void} onRetry - called when retry is clicked
 * @returns {() => void} cleanup function to stop animations
 */
function renderErrorPage(parentEl, err, filePath, onRetry) {
  const status = parseStatusCode(err.message);
  const pool = status === 404 ? NOT_FOUND_PAGES
    : ERROR_PAGES[status] ? ERROR_PAGES[status]
    : null;

  parentEl.textContent = "";
  parentEl.classList.add("doc-tile-error");

  const page = document.createElement("div");
  page.className = "doc-tile-error-page";

  let stopAnim = () => {};

  let current = pool ? pickRandom(pool) : null;

  if (pool) {
    const codeEl = document.createElement("div");
    codeEl.className = "doc-tile-error-code";
    codeEl.textContent = String(status);
    page.appendChild(codeEl);

    const artEl = document.createElement("div");
    artEl.className = "doc-tile-error-art";
    artEl.textContent = current.frames[0];
    stopAnim = animateArt(artEl, current.frames, current.ms);
    page.appendChild(artEl);

    const msgEl = document.createElement("div");
    msgEl.className = "doc-tile-error-msg";
    msgEl.textContent = current.msg;
    page.appendChild(msgEl);

    // cycle button (only if more than one option)
    if (pool.length > 1) {
      const shuffleBtn = document.createElement("button");
      shuffleBtn.className = "doc-tile-error-shuffle";
      shuffleBtn.textContent = "another one";
      shuffleBtn.addEventListener("click", () => {
        let next;
        do { next = pickRandom(pool); } while (next === current && pool.length > 1);
        current = next;
        stopAnim();
        artEl.textContent = next.frames[0];
        stopAnim = animateArt(artEl, next.frames, next.ms);
        msgEl.textContent = next.msg;
      });
      page.appendChild(shuffleBtn);
    }
  } else {
    // generic error
    const artEl = document.createElement("div");
    artEl.className = "doc-tile-error-art";
    artEl.textContent = GENERIC_FRAMES[0];
    stopAnim = animateArt(artEl, GENERIC_FRAMES, 800);
    page.appendChild(artEl);

    const msgEl = document.createElement("div");
    msgEl.className = "doc-tile-error-msg";
    msgEl.textContent = err.message;
    page.appendChild(msgEl);
  }

  const pathEl = document.createElement("div");
  pathEl.className = "doc-tile-error-path";
  pathEl.textContent = filePath;
  page.appendChild(pathEl);

  const actions = document.createElement("div");
  actions.className = "doc-tile-error-actions";

  const retryBtn = document.createElement("button");
  retryBtn.className = "doc-tile-error-btn";
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", () => { stopAnim(); onRetry(); });
  actions.appendChild(retryBtn);

  page.appendChild(actions);
  parentEl.appendChild(page);

  // Return a stable wrapper so callers always stop the *current* interval,
  // even after the shuffle button has reassigned the inner `stopAnim`.
  return () => stopAnim();
}

/** Icon name based on file extension. */
function extToIcon(ext) {
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) return "code";
  if ([".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg"].includes(ext)) return "settings";
  if ([".md"].includes(ext)) return "article";
  if ([".txt", ".log"].includes(ext)) return "document";
  if ([".py", ".rb", ".go", ".rs", ".sh", ".bash", ".zsh", ".sql"].includes(ext)) return "code";
  if ([".html", ".css"].includes(ext)) return "code";
  return "document";
}

function isMarkdown(ext, format) {
  return format === "markdown" || ext === ".md";
}

/**
 * Lazy-load CodeMirror bundle. Cached after first import.
 * @returns {Promise<object>} The CM6 exports
 */
let _cmPromise = null;
function loadCodeMirror() {
  if (!_cmPromise) {
    _cmPromise = import("/vendor/codemirror/codemirror.esm.js")
      .catch((err) => { _cmPromise = null; return Promise.reject(err); });
  }
  return _cmPromise;
}

/**
 * Build a CodeMirror language extension from a file extension.
 */
function langExtension(cm, ext) {
  const map = {
    ".js": cm.javascript, ".mjs": cm.javascript, ".cjs": cm.javascript,
    ".jsx": () => cm.javascript({ jsx: true }),
    ".ts": () => cm.javascript({ typescript: true }),
    ".tsx": () => cm.javascript({ typescript: true, jsx: true }),
    ".json": cm.json, ".jsonc": cm.json,
    ".py": cm.python,
    ".go": cm.go,
    ".rs": cm.rust,
    ".html": cm.html, ".xml": cm.html,
    ".css": cm.css,
    ".yaml": cm.yaml, ".yml": cm.yaml,
    ".sql": cm.sql,
    ".md": cm.markdown,
  };
  const factory = map[ext];
  if (!factory) return [];
  return [factory()];
}

/**
 * Build a dark theme that uses Katulong's CSS custom properties.
 */
function buildTheme(cm) {
  const { EditorView, tags, HighlightStyle, syntaxHighlighting } = cm;

  const theme = EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "var(--text-sm)",
      fontFamily: "var(--font-mono)",
    },
    ".cm-content": {
      caretColor: "var(--accent-active)",
      padding: "var(--space-sm) 0",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "var(--accent-active)",
    },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(201, 164, 245, 0.2)",
    },
    ".cm-selectionBackground": {
      backgroundColor: "rgba(201, 164, 245, 0.15)",
    },
    ".cm-panels": {
      backgroundColor: "var(--bg-surface)",
      color: "var(--text)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--border)",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(201, 164, 245, 0.3)",
      outline: "1px solid rgba(201, 164, 245, 0.5)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(201, 164, 245, 0.5)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--text-dim)",
      border: "none",
      paddingRight: "var(--space-xs)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
      color: "var(--text-muted)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--accent)",
      color: "var(--text-muted)",
      border: "none",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-surface)",
      color: "var(--text)",
      border: "1px solid var(--border)",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "var(--accent)",
        color: "var(--text)",
      },
    },
    ".cm-scroller": {
      overflow: "auto",
    },
  }, { dark: true });

  const highlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: "#c9a4f5" },
    { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: "#eae6f0" },
    { tag: [tags.function(tags.variableName)], color: "#7acf7e" },
    { tag: [tags.labelName], color: "#eae6f0" },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: "#d3b63b" },
    { tag: [tags.definition(tags.name), tags.separator], color: "#eae6f0" },
    { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: "#d3b63b" },
    { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: "#c9a4f5" },
    { tag: [tags.meta, tags.comment], color: "#928c9c" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
    { tag: tags.link, color: "#c9a4f5", textDecoration: "underline" },
    { tag: tags.heading, fontWeight: "bold", color: "#c9a4f5" },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: "#ff968a" },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: "#7acf7e" },
    { tag: tags.invalid, color: "#ff968a" },
  ]);

  return [theme, syntaxHighlighting(highlightStyle)];
}

/**
 * @returns {(options: { filePath?, title?, content?, format? }) => TilePrototype}
 */
export function createDocumentTileFactory(_deps = {}) {
  return function createDocumentTile({ filePath, title, content, format, worktreeLabel } = {}) {
    let container = null;
    let mounted = false;
    let editorView = null;
    let dirty = false;
    let saving = false;
    let statusEl = null;
    let originalContent = "";
    let stopErrorAnim = null;
    let watcher = null;
    let conflictBarEl = null;
    let pendingDiskContent = null;
    let headerEl = null;

    const isFileBacked = !!filePath;
    const ext = filePath
      ? (filePath.includes(".") ? "." + filePath.split(".").pop().toLowerCase() : "")
      : "";
    const filename = filePath
      ? (filePath.split("/").filter(Boolean).pop() || "file")
      : (title || "document");
    const renderAsMarkdown = isMarkdown(ext, format);

    function updateStatus(text, className) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.className = "doc-tile-status " + (className || "");
    }

    /** Replace editor contents without triggering a dirty flag. */
    function applyDiskToEditor(text) {
      if (!editorView) return;
      // Set originalContent first so the CM updateListener, which runs
      // synchronously during dispatch, compares the new doc against the
      // new baseline instead of the stale one.
      originalContent = text;
      dirty = false;
      const prevHead = editorView.state.selection.main.head;
      const newHead = Math.min(prevHead, text.length);
      editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: text },
        selection: { anchor: newHead },
      });
      updateStatus("", "");
    }

    function hideConflict() {
      pendingDiskContent = null;
      if (conflictBarEl) {
        conflictBarEl.remove();
        conflictBarEl = null;
      }
    }

    function showConflict(diskContent) {
      // Always refresh the cached disk content so Revert applies the newest
      // version — the disk can change repeatedly while the banner is up.
      pendingDiskContent = diskContent;
      if (conflictBarEl) return;
      if (!headerEl) return;

      conflictBarEl = document.createElement("div");
      conflictBarEl.className = "doc-tile-conflict";
      conflictBarEl.setAttribute("role", "alert");

      const msg = document.createElement("span");
      msg.className = "doc-tile-conflict-msg";
      msg.textContent = "File changed on disk. Your edits differ.";
      conflictBarEl.appendChild(msg);

      const revert = document.createElement("button");
      revert.type = "button";
      revert.className = "doc-tile-conflict-btn";
      revert.textContent = "Revert";
      revert.addEventListener("click", () => {
        if (pendingDiskContent != null) applyDiskToEditor(pendingDiskContent);
        hideConflict();
      });
      conflictBarEl.appendChild(revert);

      const overwrite = document.createElement("button");
      overwrite.type = "button";
      overwrite.className = "doc-tile-conflict-btn doc-tile-conflict-btn-primary";
      overwrite.textContent = "Overwrite";
      overwrite.addEventListener("click", saveFile);
      conflictBarEl.appendChild(overwrite);

      headerEl.insertAdjacentElement("afterend", conflictBarEl);
    }

    async function saveFile() {
      if (!isFileBacked || !editorView || saving || !dirty) return;
      saving = true;
      updateStatus("Saving…", "");
      try {
        const newContent = editorView.state.doc.toString();
        await api.post("/api/files/write", { path: filePath, content: newContent });
        originalContent = newContent;
        dirty = false;
        hideConflict();
        updateStatus("Saved", "doc-tile-status-ok");
        setTimeout(() => { if (!dirty && mounted) updateStatus("", ""); }, 2000);
      } catch (err) {
        updateStatus(`Save failed: ${err.message}`, "doc-tile-status-err");
      } finally {
        saving = false;
      }
    }

    const tile = {
      type: "document",
      persistable: isFileBacked,

      get filePath() { return filePath || null; },

      mount(el, ctx) {
        container = el;
        mounted = true;

        const root = document.createElement("div");
        root.className = "doc-tile-root";

        const header = document.createElement("div");
        header.className = "doc-tile-header";
        headerEl = header;

        if (worktreeLabel) {
          const badge = document.createElement("span");
          badge.className = "tile-worktree-badge";
          badge.textContent = worktreeLabel;
          badge.title = `Worktree: ${worktreeLabel}`;
          header.appendChild(badge);
        }

        const headerTitle = document.createElement("span");
        headerTitle.className = "doc-tile-header-title";
        headerTitle.textContent = filePath || title || "";
        header.appendChild(headerTitle);

        statusEl = document.createElement("span");
        statusEl.className = "doc-tile-status";
        header.appendChild(statusEl);

        const closeBtn = document.createElement("button");
        closeBtn.className = "fb-btn fb-close-btn";
        closeBtn.setAttribute("aria-label", "Close document");
        closeBtn.innerHTML = '<i class="ph ph-x"></i>';
        closeBtn.addEventListener("click", () => ctx?.requestClose?.());
        header.appendChild(closeBtn);

        root.appendChild(header);

        if (renderAsMarkdown) {
          // --- Markdown rendering ---
          const contentEl = document.createElement("div");
          contentEl.className = "doc-tile-content doc-tile-markdown";
          contentEl.tabIndex = 0;
          root.appendChild(contentEl);
          el.appendChild(root);

          if (isFileBacked) {
            // Silent re-fetch used by the watcher — no "Loading…" flash,
            // content replaced only on success so a transient fetch error
            // doesn't blank out a working view.
            const refreshMarkdown = () => {
              api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
                .then((data) => {
                  if (!mounted) return;
                  contentEl.classList.remove("doc-tile-error");
                  contentEl.innerHTML = DOMPurify.sanitize(marked.parse(data.content));
                })
                .catch(() => { /* keep previous content */ });
            };

            const loadMarkdown = () => {
              if (stopErrorAnim) { stopErrorAnim(); stopErrorAnim = null; }
              contentEl.textContent = "Loading…";
              contentEl.classList.remove("doc-tile-error");
              contentEl.innerHTML = "";
              api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
                .then((data) => {
                  if (!mounted) return;
                  contentEl.innerHTML = DOMPurify.sanitize(marked.parse(data.content));
                  if (!watcher) {
                    watcher = createDocumentWatcher({ filePath, onChange: refreshMarkdown });
                  }
                })
                .catch((err) => {
                  if (!mounted) return;
                  stopErrorAnim = renderErrorPage(contentEl, err, filePath, loadMarkdown);
                });
            };
            loadMarkdown();
          } else if (content != null) {
            contentEl.innerHTML = DOMPurify.sanitize(marked.parse(content));
          }
        } else {
          // --- CodeMirror editor ---
          const editorContainer = document.createElement("div");
          editorContainer.className = "doc-tile-editor";
          root.appendChild(editorContainer);
          el.appendChild(root);

          const initialContent = content ?? "";

          const setupEditor = async (text) => {
            if (!mounted) return;
            editorContainer.textContent = "";
            editorContainer.style.padding = "";
            editorContainer.style.color = "";

            const cm = await loadCodeMirror();
            if (!mounted) return;

            originalContent = text;

            const saveKeymap = [{
              key: "Mod-s",
              run: () => { saveFile(); return true; },
            }];

            const extensions = [
              cm.lineNumbers(),
              cm.highlightActiveLineGutter(),
              cm.highlightSpecialChars(),
              cm.history(),
              cm.foldGutter(),
              cm.drawSelection(),
              cm.dropCursor(),
              cm.indentOnInput(),
              cm.bracketMatching(),
              cm.closeBrackets(),
              cm.autocompletion(),
              cm.rectangularSelection(),
              cm.crosshairCursor(),
              cm.highlightActiveLine(),
              cm.highlightSelectionMatches(),
              cm.keymap.of([
                ...saveKeymap,
                cm.indentWithTab,
                ...cm.closeBracketsKeymap,
                ...cm.defaultKeymap,
                ...cm.searchKeymap,
                ...cm.historyKeymap,
                ...cm.foldKeymap,
                ...cm.completionKeymap,
                ...cm.lintKeymap,
              ]),
              ...langExtension(cm, ext),
              ...buildTheme(cm),
              cm.EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  const newDirty = update.state.doc.toString() !== originalContent;
                  if (newDirty !== dirty) {
                    dirty = newDirty;
                    updateStatus(dirty ? "Modified" : "", dirty ? "doc-tile-status-dirty" : "");
                  }
                  // If the user edits back to the disk version while a conflict
                  // banner is up, there's nothing left to reconcile.
                  if (!dirty && conflictBarEl) hideConflict();
                }
              }),
            ];

            editorView = new cm.EditorView({
              state: cm.EditorState.create({ doc: text, extensions }),
              parent: editorContainer,
            });
          };

          if (isFileBacked) {
            // Called by the watcher on every fs change. Silent no-op when
            // disk matches the buffer (including the common case where the
            // change was our own save). If disk differs and the buffer is
            // clean, sync silently; if the buffer is dirty, VSCode-style
            // conflict banner lets the user choose Revert or Overwrite.
            const handleDiskChange = () => {
              if (!mounted || !editorView) return;
              api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
                .then((data) => {
                  if (!mounted || !editorView) return;
                  // Guard against a malformed/empty response so we never
                  // dispatch `undefined` into CodeMirror.
                  if (typeof data?.content !== "string") return;
                  const currentDoc = editorView.state.doc.toString();
                  if (data.content === currentDoc) {
                    originalContent = data.content;
                    return;
                  }
                  if (!dirty) {
                    applyDiskToEditor(data.content);
                  } else {
                    showConflict(data.content);
                  }
                })
                .catch(() => { /* transient read failure — wait for next event */ });
            };

            const loadFile = () => {
              if (stopErrorAnim) { stopErrorAnim(); stopErrorAnim = null; }
              editorContainer.textContent = "Loading…";
              editorContainer.style.padding = "var(--space-sm)";
              editorContainer.style.color = "var(--text-dim)";
              editorContainer.classList.remove("doc-tile-error");
              api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
                .then((data) => {
                  if (!mounted) return;
                  return setupEditor(data.content).then(() => {
                    if (!mounted) return;
                    if (!watcher) {
                      watcher = createDocumentWatcher({ filePath, onChange: handleDiskChange });
                    }
                  });
                })
                .catch((err) => {
                  if (!mounted) return;
                  editorContainer.style.padding = "";
                  editorContainer.style.color = "";
                  stopErrorAnim = renderErrorPage(editorContainer, err, filePath, loadFile);
                });
            };
            loadFile();
          } else {
            const loadInline = () => {
              if (stopErrorAnim) { stopErrorAnim(); stopErrorAnim = null; }
              editorContainer.classList.remove("doc-tile-error");
              setupEditor(initialContent).catch((err) => {
                if (!mounted) return;
                stopErrorAnim = renderErrorPage(editorContainer, err, filePath || "inline content", loadInline);
              });
            };
            loadInline();
          }
        }
      },

      unmount() {
        if (!mounted) return;
        if (watcher) { watcher.stop(); watcher = null; }
        hideConflict();
        if (stopErrorAnim) { stopErrorAnim(); stopErrorAnim = null; }
        if (editorView) {
          editorView.destroy();
          editorView = null;
        }
        if (container) container.innerHTML = "";
        container = null;
        headerEl = null;
        mounted = false;
        dirty = false;
        statusEl = null;
      },

      focus() {
        if (editorView) {
          editorView.focus();
        } else if (container) {
          const el = container.querySelector(".doc-tile-content");
          if (el) el.focus();
        }
      },

      blur() {},

      resize() {
        // CM6 auto-measures; no explicit resize needed
      },

      getTitle() { return filename; },
      getIcon() { return extToIcon(ext); },

      serialize() {
        if (isFileBacked) {
          const out = { type: "document", filePath };
          if (worktreeLabel) out.worktreeLabel = worktreeLabel;
          return out;
        }
        return { type: "document", title, format };
      },
    };

    return tile;
  };
}
