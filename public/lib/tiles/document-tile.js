/**
 * Document Tile
 *
 * Generic read-only document viewer. Two modes:
 *   - File-backed: given a filePath, fetches content from /api/files/read
 *     on mount. Persistable — re-fetches on restore.
 *   - Content-backed: given title + content + format directly. Not
 *     persistable (content too large for localStorage).
 *
 * Markdown files (.md ext or format: "markdown") are rendered as HTML
 * via vendored marked.js. All other formats render in a <pre> tag.
 */

import { api } from "/lib/api-client.js";
import { marked } from "/vendor/marked/marked.esm.js";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";

/** Map file extension to a CSS class for syntax-appropriate styling. */
function extToLang(ext) {
  const map = {
    ".js": "lang-js", ".mjs": "lang-js", ".cjs": "lang-js",
    ".ts": "lang-ts", ".tsx": "lang-ts", ".jsx": "lang-js",
    ".json": "lang-json", ".jsonc": "lang-json",
    ".py": "lang-py", ".rb": "lang-rb", ".go": "lang-go",
    ".rs": "lang-rs", ".sh": "lang-sh", ".bash": "lang-sh",
    ".zsh": "lang-sh",
    ".html": "lang-html", ".css": "lang-css", ".xml": "lang-xml",
    ".yaml": "lang-yaml", ".yml": "lang-yaml", ".toml": "lang-toml",
    ".md": "lang-md", ".txt": "lang-txt",
    ".sql": "lang-sql", ".graphql": "lang-graphql",
    ".env": "lang-env", ".ini": "lang-ini", ".cfg": "lang-ini",
    ".log": "lang-log",
  };
  return map[ext] || "lang-plain";
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
 * @returns {(options: { filePath?, title?, content?, format? }) => TilePrototype}
 */
export function createDocumentTileFactory(_deps = {}) {
  return function createDocumentTile({ filePath, title, content, format } = {}) {
    let container = null;
    let mounted = false;

    const isFileBacked = !!filePath;
    const ext = filePath
      ? (filePath.includes(".") ? "." + filePath.split(".").pop().toLowerCase() : "")
      : "";
    const filename = filePath
      ? (filePath.split("/").filter(Boolean).pop() || "file")
      : (title || "document");
    const renderAsMarkdown = isMarkdown(ext, format);

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

        const closeBtn = document.createElement("button");
        closeBtn.className = "fb-btn fb-close-btn";
        closeBtn.setAttribute("aria-label", "Close document");
        closeBtn.innerHTML = '<i class="ph ph-x"></i>';
        closeBtn.addEventListener("click", () => ctx?.requestClose?.());
        header.appendChild(closeBtn);

        root.appendChild(header);

        let contentEl;
        if (renderAsMarkdown) {
          contentEl = document.createElement("div");
          contentEl.className = "doc-tile-content doc-tile-markdown";
          contentEl.tabIndex = 0;
        } else {
          contentEl = document.createElement("pre");
          contentEl.className = `doc-tile-content ${extToLang(ext)}`;
          contentEl.tabIndex = 0;
        }
        root.appendChild(contentEl);
        el.appendChild(root);

        if (isFileBacked) {
          contentEl.textContent = "Loading\u2026";
          api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`)
            .then((data) => {
              if (!mounted) return;
              if (renderAsMarkdown) {
                contentEl.innerHTML = DOMPurify.sanitize(marked.parse(data.content));
              } else {
                contentEl.textContent = data.content;
              }
            })
            .catch((err) => {
              if (!mounted) return;
              contentEl.textContent = `Error: ${err.message}`;
              contentEl.classList.add("doc-tile-error");
            });
        } else if (content != null) {
          if (renderAsMarkdown) {
            contentEl.innerHTML = DOMPurify.sanitize(marked.parse(content));
          } else {
            contentEl.textContent = content;
          }
        }
      },

      unmount() {
        if (!mounted) return;
        if (container) container.innerHTML = "";
        container = null;
        mounted = false;
      },

      focus() {
        if (container) {
          const el = container.querySelector(".doc-tile-content");
          if (el) el.focus();
        }
      },

      blur() {},
      resize() {},

      getTitle() { return filename; },
      getIcon() { return extToIcon(ext); },

      serialize() {
        if (isFileBacked) {
          return { type: "document", filePath };
        }
        // Content-backed tiles are not persistable, but return a
        // minimal shape as a safety net.
        return { type: "document", title, format };
      },
    };

    return tile;
  };
}
