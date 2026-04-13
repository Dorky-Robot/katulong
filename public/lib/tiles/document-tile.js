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
 */

import { api } from "/lib/api-client.js";
import { marked } from "/vendor/marked/marked.esm.js";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";

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
  return function createDocumentTile({ filePath, title, content, format } = {}) {
    let container = null;
    let mounted = false;
    let editorView = null;
    let dirty = false;
    let saving = false;
    let statusEl = null;
    let originalContent = "";

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

    async function saveFile() {
      if (!isFileBacked || !editorView || saving || !dirty) return;
      saving = true;
      updateStatus("Saving…", "");
      try {
        const newContent = editorView.state.doc.toString();
        await api.post("/api/files/write", { path: filePath, content: newContent });
        originalContent = newContent;
        dirty = false;
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
          // --- Markdown rendering (unchanged) ---
          const contentEl = document.createElement("div");
          contentEl.className = "doc-tile-content doc-tile-markdown";
          contentEl.tabIndex = 0;
          root.appendChild(contentEl);
          el.appendChild(root);

          if (isFileBacked) {
            contentEl.textContent = "Loading…";
            api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
              .then((data) => {
                if (!mounted) return;
                contentEl.innerHTML = DOMPurify.sanitize(marked.parse(data.content));
              })
              .catch((err) => {
                if (!mounted) return;
                contentEl.textContent = `Error: ${err.message}`;
                contentEl.classList.add("doc-tile-error");
              });
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

          // Show loading placeholder while CM loads
          if (isFileBacked) {
            editorContainer.textContent = "Loading…";
            editorContainer.style.padding = "var(--space-sm)";
            editorContainer.style.color = "var(--text-dim)";
          }

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
                }
              }),
            ];

            editorView = new cm.EditorView({
              state: cm.EditorState.create({ doc: text, extensions }),
              parent: editorContainer,
            });
          };

          if (isFileBacked) {
            api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
              .then((data) => {
                if (!mounted) return;
                setupEditor(data.content);
              })
              .catch((err) => {
                if (!mounted) return;
                editorContainer.textContent = `Error: ${err.message}`;
                editorContainer.classList.add("doc-tile-error");
              });
          } else {
            setupEditor(initialContent).catch((err) => {
              if (!mounted) return;
              editorContainer.textContent = `Error: ${err.message}`;
              editorContainer.classList.add("doc-tile-error");
            });
          }
        }
      },

      unmount() {
        if (!mounted) return;
        if (editorView) {
          editorView.destroy();
          editorView = null;
        }
        if (container) container.innerHTML = "";
        container = null;
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
          return { type: "document", filePath };
        }
        return { type: "document", title, format };
      },
    };

    return tile;
  };
}
