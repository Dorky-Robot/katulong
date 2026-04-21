/**
 * Feed Tile Renderer
 *
 * Subscribes to a pub/sub topic via SSE and renders events according to
 * topic metadata. Pure subscriber — no knowledge of who produces events.
 *
 * Routing:
 *   - `claude/<uuid>` topics stream via `/api/claude/stream/:uuid`. That
 *     endpoint acquires a per-UUID processor refcount for the lifetime
 *     of the connection. Opt-in (POST /api/claude/watch) happens
 *     elsewhere — typically the sparkle-click handler in app.js.
 *   - Any other topic streams via `/sub/<topic>`, the generic broker SSE.
 *
 * Event shape (progress topics):
 *   reply — { status, entryId, step, ts, files?: [{ path, line? }] }
 *           One full Claude reply per turn. Rendered flat (no <details>):
 *           a timestamp + file chips row on top, the reply prose below.
 *           Files chips are clickable and open a document tile.
 *
 * Lifecycle:
 *   1. Mount with `props.topic` → stream immediately.
 *   2. Mount without → inline topic picker (from /api/topics).
 *   3. Rendering strategy chosen by `props.meta.type`:
 *        "progress" — Claude reply cards.
 *        default    — chronological event log with timestamps.
 */

// Markdown rendering for reply bodies. Dynamic-imported so the module
// still loads in environments (Node tests) that can't resolve the
// /vendor/... browser paths. When the import succeeds we render markdown
// → sanitized HTML; when it fails we fall back to setting textContent
// and the tests never hit the real parser.
let renderMarkdown = (el, text) => { el.textContent = text || ""; };
try {
  const [{ marked }, purifyMod] = await Promise.all([
    import("/vendor/marked/marked.esm.js"),
    import("/vendor/dompurify/purify.es.mjs"),
  ]);
  const DOMPurify = purifyMod.default;
  renderMarkdown = (el, text) => {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ""));
  };
} catch {
  // Fallback already set above.
}

// Pull numbered options off the end of a reply so the feed can offer
// quick-pick buttons. Accepts the common Claude prompt shape:
//
//     Some preamble question?
//
//     1. Yes, do the thing
//     2. No, cancel
//     3. Ask me something else
//
// Returns the trailing option block as `[{ key, label }]` only when
// we see at least two consecutive numbered items at the end of the
// reply; anything less is noise (a standalone "1." inside prose is
// usually part of a discussion, not an option list).
export function parseReplyOptions(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const lines = text.split("\n");
  const opts = [];
  // Walk backwards, collecting trailing `\d+. ...` lines. Stop on the
  // first non-option, non-blank line so only the TAIL qualifies — a
  // numbered list in the middle of a reply isn't an answer prompt.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) { if (opts.length === 0) continue; break; }
    const m = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);
    if (!m) break;
    opts.push({ key: m[1], label: m[2] });
  }
  if (opts.length < 2) return [];
  return opts.reverse();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function streamUrlForTopic(topic) {
  if (typeof topic === "string" && topic.startsWith("claude/")) {
    const uuid = topic.slice("claude/".length);
    if (UUID_RE.test(uuid)) {
      return `/api/claude/stream/${encodeURIComponent(uuid)}?fromSeq=0`;
    }
  }
  return `/sub/${encodeURIComponent(topic)}?fromSeq=0`;
}

// ── Rendering strategies ────────────────────────────────────────────

function formatTime(ts) {
  if (!ts && ts !== 0) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function makeTimeSpan(ts) {
  const t = document.createElement("span");
  t.className = "feed-tile-row-time";
  t.textContent = formatTime(ts);
  return t;
}

// Split a textarea value around `[Image #N]` placeholders into an
// ordered token list the server can replay. Unknown N (placeholder
// text that points to nothing in the stash) passes through as literal
// text — so a user who pastes the string `[Image #99]` from somewhere
// else doesn't get their reply silently gutted.
export function buildReplyTokens(value, imagePaths) {
  if (typeof value !== "string" || value.length === 0) return [];
  const parts = value.split(/(\[Image #\d+\])/g);
  const out = [];
  function pushText(s) {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += s;
    else out.push({ type: "text", value: s });
  }
  for (const part of parts) {
    const m = part.match(/^\[Image #(\d+)\]$/);
    if (m) {
      const path = imagePaths.get(parseInt(m[1], 10));
      if (path) { out.push({ type: "image", path }); continue; }
    }
    pushText(part);
  }
  return out;
}

// A pinned-to-bottom composer for Claude topics. Shows quick-pick
// buttons when the latest reply ends in a numbered options list, plus
// a textarea + Send button for typed responses. Inline images: paste
// an image into the textarea, we upload it to /upload and insert an
// `[Image #N]` placeholder — on send, the server replays the text +
// image tokens into the Claude pane in the same order.
function createResponseBar(claudeUuid) {
  const el = document.createElement("div");
  el.className = "feed-tile-response-bar";

  const optionsRow = document.createElement("div");
  optionsRow.className = "feed-tile-response-options";
  optionsRow.style.display = "none";
  el.appendChild(optionsRow);

  const textarea = document.createElement("textarea");
  textarea.className = "feed-tile-response-textarea";
  textarea.rows = 4;
  textarea.placeholder = "Reply to Claude — paste images inline, Enter to send, Shift+Enter for newline";
  el.appendChild(textarea);

  const status = document.createElement("div");
  status.className = "feed-tile-response-status";
  el.appendChild(status);

  // Inline-image state. `imagePaths` maps a placeholder number to the
  // server-side path returned from /upload. Cleared after a successful
  // send; orphaned entries (user deleted the placeholder text) are
  // dropped at send time because buildReplyTokens only emits image
  // tokens for N values still present in the textarea.
  const imagePaths = new Map();
  let imageCounter = 0;

  function resetImageState() {
    imagePaths.clear();
    imageCounter = 0;
  }

  let sending = false;
  async function send(text) {
    if (sending) return;
    if (!text || !text.trim()) return;
    sending = true;
    textarea.disabled = true;
    status.textContent = "Sending…";
    status.className = "feed-tile-response-status";
    try {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const headers = { "Content-Type": "application/json" };
      if (csrfMeta?.content) headers["X-CSRF-Token"] = csrfMeta.content;
      const tokens = buildReplyTokens(text, imagePaths);
      const hasImages = tokens.some((t) => t.type === "image");
      const payload = hasImages ? { tokens } : { text };
      const res = await fetch(`/api/claude/respond/${encodeURIComponent(claudeUuid)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        credentials: "same-origin",
        redirect: "error",
      });
      if (!res.ok) {
        let msg = `Send failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      textarea.value = "";
      resetImageState();
      status.textContent = "Sent.";
      setTimeout(() => {
        if (status.textContent === "Sent.") status.textContent = "";
      }, 1500);
    } catch (err) {
      status.textContent = err.message || "Send failed";
      status.classList.add("feed-tile-response-status-error");
    } finally {
      sending = false;
      textarea.disabled = false;
      textarea.focus();
    }
  }

  async function uploadReplyImage(file) {
    const headers = { "Content-Type": "application/octet-stream" };
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    if (csrfMeta?.content) headers["X-CSRF-Token"] = csrfMeta.content;
    const res = await fetch("/upload", {
      method: "POST", headers, body: file,
      credentials: "same-origin", redirect: "error",
    });
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    const data = await res.json();
    return data.path;
  }

  function insertAtCursor(ta, s) {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + s + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + s.length;
  }

  textarea.addEventListener("paste", async (ev) => {
    const dt = ev.clipboardData;
    if (!dt) return;
    const images = [];
    // Safari only exposes pasted images via `items`; Chrome/Firefox
    // fill `files` too. Check both, de-duping on reference identity so
    // a browser that populates both doesn't double-upload.
    const seen = new Set();
    for (const item of dt.items || []) {
      if (item.type?.startsWith("image/")) {
        const f = item.getAsFile();
        if (f && !seen.has(f)) { images.push(f); seen.add(f); }
      }
    }
    for (const f of dt.files || []) {
      if (f.type?.startsWith("image/") && !seen.has(f)) { images.push(f); seen.add(f); }
    }
    if (images.length === 0) return;  // fall through to default text paste
    ev.preventDefault();
    status.textContent = images.length === 1 ? "Uploading image…" : `Uploading ${images.length} images…`;
    try {
      for (const f of images) {
        const path = await uploadReplyImage(f);
        const n = ++imageCounter;
        imagePaths.set(n, path);
        insertAtCursor(textarea, `[Image #${n}]`);
      }
      status.textContent = "";
    } catch (err) {
      status.textContent = err.message || "Upload failed";
      status.classList.add("feed-tile-response-status-error");
    }
  });

  textarea.addEventListener("keydown", (ev) => {
    // Enter alone sends — matching chat apps' default and how a user
    // expects to submit a reply. Shift+Enter inserts a literal newline
    // for the occasional multi-line message. The IME composition guard
    // avoids firing while the user is still mid-compose on Asian input
    // methods, where Enter commits the candidate instead of submitting.
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      send(textarea.value);
    }
  });

  function setOptions(replyText) {
    const opts = parseReplyOptions(replyText);
    optionsRow.innerHTML = "";
    if (opts.length === 0) {
      optionsRow.style.display = "none";
      return;
    }
    optionsRow.style.display = "";
    for (const opt of opts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "feed-tile-response-option";
      const num = document.createElement("span");
      num.className = "feed-tile-response-option-num";
      num.textContent = opt.key;
      btn.appendChild(num);
      const label = document.createElement("span");
      label.className = "feed-tile-response-option-label";
      label.textContent = opt.label;
      btn.appendChild(label);
      btn.addEventListener("click", () => {
        // Hide immediately so a fast second click can't send the same
        // choice again. The row repopulates on the next reply if that
        // reply ends in another numbered list, and stays hidden
        // otherwise.
        optionsRow.style.display = "none";
        optionsRow.innerHTML = "";
        send(opt.key);
      });
      optionsRow.appendChild(btn);
    }
  }

  return { el, setOptions };
}

// Extensions we recognize as files when we see them in prose without
// a surrounding slash — e.g., "app-routes.js:99" with no directory is
// still clearly a source file. Keeping this list conservative stops
// us from linkifying dotted identifiers like `session.meta.claude`
// just because they happen to end with a few letters. Extend as new
// file kinds come up in Claude's output.
const KNOWN_PATH_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "mdx",
  "html", "htm", "css", "scss", "less",
  "yaml", "yml", "toml", "ini", "conf", "env",
  "sh", "zsh", "bash", "fish",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cc", "cxx",
  "php", "lua", "sql", "txt", "log", "xml", "svg",
  "vue", "svelte", "sol", "proto",
]);

/**
 * Decide whether an inline `<code>` text looks like a file path we
 * should make clickable. Accepts:
 *   - ~/path/... or /abs/path with at least one slash
 *   - path/with/slashes + .ext
 *   - filename.ext with a known extension (file.js, app-routes.js:99)
 * Rejects anything with whitespace, URL schemes, angle brackets, or
 * a leading dot (CSS class selectors, dotfiles without a directory).
 */
export function looksLikeFilePath(raw) {
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (!text || /\s/.test(text)) return false;
  if (text.includes("://") || text.startsWith("mailto:")) return false;
  if (/[<>{}"`]/.test(text)) return false;
  if (text.startsWith(".")) return false;
  if (text.startsWith("~/")) return true;
  if (text.startsWith("/")) return text.indexOf("/", 1) > 0;
  const lineStripped = text.replace(/:\d+$/, "");
  const extMatch = lineStripped.match(/\.([a-zA-Z][a-zA-Z0-9]{0,7})$/);
  if (!extMatch) return false;
  if (lineStripped.includes("/")) return true;
  return KNOWN_PATH_EXTS.has(extMatch[1].toLowerCase());
}

/** Split "path:123" → { path, line } ; "path" → { path, line: null } */
export function parsePathAndLine(text) {
  const m = text.match(/^(.+?):(\d+)$/);
  if (m) return { path: m[1], line: parseInt(m[2], 10) };
  return { path: text, line: null };
}

// Post-render pass: any inline <code> whose text looks like a file
// path becomes a clickable button that reuses the same
// `katulong:open-file` event the terminal's file-link handler fires.
// Fenced code blocks (<pre><code>) are skipped — they're code samples,
// not references.
function linkifyInlineCodePaths(root) {
  const codes = root.querySelectorAll("code");
  for (const code of codes) {
    if (code.closest("pre")) continue;
    const text = (code.textContent || "").trim();
    if (!looksLikeFilePath(text)) continue;
    const { path, line } = parsePathAndLine(text);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "feed-tile-prose-link";
    btn.textContent = code.textContent;
    btn.title = text;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      window.dispatchEvent(new CustomEvent("katulong:open-file", {
        detail: { path, line },
      }));
    });
    code.replaceWith(btn);
  }
}

// Compaction summaries replay earlier image inputs as the literal
// string `[Image: source: /abs/path.png]` in the user prompt. Marked
// renders that as plaintext (no `()` target = not a markdown link),
// so we post-process text nodes and swap it for a square thumbnail.
// Clicking the thumbnail opens the image tile via the same event as
// any other file link.
const IMAGE_REF_RE = /\[Image:\s*source:\s*(\/[^\]\s]+)\s*\]/g;

function makeImageThumb(absPath) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "feed-tile-image-thumb";
  btn.title = absPath;
  const img = document.createElement("img");
  img.src = `/api/files/image?path=${encodeURIComponent(absPath)}`;
  img.alt = absPath.split("/").pop() || absPath;
  img.loading = "lazy";
  btn.appendChild(img);
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    window.dispatchEvent(new CustomEvent("katulong:open-file", {
      detail: { path: absPath, line: null },
    }));
  });
  return btn;
}

function replaceImageRefsInTextNode(node) {
  const text = node.nodeValue || "";
  IMAGE_REF_RE.lastIndex = 0;
  let match;
  let lastIdx = 0;
  const frag = document.createDocumentFragment();
  while ((match = IMAGE_REF_RE.exec(text)) !== null) {
    if (match.index > lastIdx) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    frag.appendChild(makeImageThumb(match[1]));
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx === 0) return;
  if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
  node.replaceWith(frag);
}

function thumbnailImageRefs(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.includes("[Image:")) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const hits = [];
  while (walker.nextNode()) hits.push(walker.currentNode);
  for (const node of hits) replaceImageRefsInTextNode(node);
}

// Apply both enrichment passes to a rendered-markdown root in the
// order that matters: thumbnails first (they split text nodes), then
// inline-code linkification (DOM walk on <code> elements is unaffected
// by text-node edits).
export function enrichFeedProse(root) {
  if (!root) return;
  thumbnailImageRefs(root);
  linkifyInlineCodePaths(root);
}

// File chips shown inline on the header row — clicking one dispatches a
// window CustomEvent that app.js catches to open the file in a document
// tile (same path as a file link clicked in the terminal).
function makeFileChip(file) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "feed-tile-reply-file";
  const base = (file.path || "").split("/").filter(Boolean).pop() || file.path;
  chip.textContent = file.line ? `${base}:${file.line}` : base;
  chip.title = file.line ? `${file.path}:${file.line}` : file.path;
  chip.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    window.dispatchEvent(new CustomEvent("katulong:open-file", {
      detail: { path: file.path, line: file.line },
    }));
  });
  return chip;
}

// Reply block. A reply now owns the intermediate tool calls that ran
// UNDER it (Option B folding: tools land after the reply that kicked
// them off and belong to that reply). Structure:
//
//   <div class="feed-tile-reply-block feed-status-reply ...">
//     <div class="feed-tile-reply-header">        ← clickable
//       <div class="feed-tile-reply-body">…</div>
//       <div class="feed-tile-reply-footer">time · files · chevron</div>
//     </div>
//     <div class="feed-tile-reply-tools">        ← nested tool rows
//       <div class="feed-tile-item feed-status-tool …">…</div>
//     </div>
//   </div>
//
// Modifier classes toggled at runtime:
//   is-active    — most recent reply; next reply strips this
//   is-expanded  — tools list revealed (auto for active, toggle via tap)
//   has-tools    — at least one tool attached (shows chevron, enables tap)
//   is-running   — at least one tool still in flight (animates border)
function createReplyEntry() {
  const block = document.createElement("div");
  const header = document.createElement("div");
  header.className = "feed-tile-reply-header";
  const body = document.createElement("div");
  body.className = "feed-tile-reply-body";
  const footer = document.createElement("div");
  footer.className = "feed-tile-reply-footer";
  const toolsEl = document.createElement("div");
  toolsEl.className = "feed-tile-reply-tools";
  header.appendChild(body);
  header.appendChild(footer);
  block.appendChild(header);
  block.appendChild(toolsEl);
  const entry = {
    kind: "reply",
    block, header, body, footer, toolsEl,
    tools: new Map(),       // toolUseId → current state
    msg: null, ts: null,
    isActive: false,
    expanded: false,
  };
  header.addEventListener("click", () => {
    entry.expanded = !entry.expanded;
    applyReplyClasses(entry);
  });
  // className is set by the caller via applyReplyClasses() after it
  // configures isActive/expanded — skipping it here avoids a write
  // that would be immediately overwritten.
  return entry;
}

function applyReplyClasses(entry) {
  const cls = ["feed-tile-item", "feed-status-reply", "feed-tile-reply-block"];
  if (entry.tools.size > 0) cls.push("has-tools");
  if (entry.isActive) cls.push("is-active");
  if (entry.expanded) cls.push("is-expanded");
  let anyRunning = false;
  for (const state of entry.tools.values()) {
    if (state !== "ok" && state !== "error") { anyRunning = true; break; }
  }
  if (anyRunning) cls.push("is-running");
  entry.block.className = cls.join(" ");
}

// Build the interactive permission-request card. Claude's own TTY
// already shows its numbered menu; the card mirrors the same three
// choices so the reader doesn't need to remember the keystroke.
// Dismiss is the fourth option for "I already answered in the terminal,
// stop showing this card" — it skips the tmux write entirely.
//
// `claudeUuid` is captured in the outer scope; card clicks POST to a
// uuid-agnostic endpoint, so the closure only needs `requestId` from
// the message.
const PERMISSION_CHOICES = [
  { choice: "allow", label: "Allow once", icon: "ph-check" },
  { choice: "allow-session", label: "Allow this session", icon: "ph-check-circle" },
  { choice: "deny", label: "Deny", icon: "ph-x" },
  { choice: "dismiss", label: "Dismiss", icon: "ph-eye-slash" },
];

function renderPermissionCard(msg, _claudeUuid, cards) {
  const row = document.createElement("div");
  row.className = "feed-tile-item feed-tile-permission";

  const header = document.createElement("div");
  header.className = "feed-tile-permission-header";
  const icon = document.createElement("i");
  icon.className = "ph ph-hand-waving";
  header.appendChild(icon);
  const title = document.createElement("span");
  title.className = "feed-tile-permission-title";
  title.textContent = msg.tool
    ? `Claude wants permission to use ${msg.tool}`
    : "Claude is waiting for your input";
  header.appendChild(title);
  row.appendChild(header);

  if (msg.message) {
    const body = document.createElement("div");
    body.className = "feed-tile-permission-message";
    body.textContent = msg.message;
    row.appendChild(body);
  }

  const buttonsEl = document.createElement("div");
  buttonsEl.className = "feed-tile-permission-buttons";
  const buttons = [];
  for (const { choice, label, icon: iconClass } of PERMISSION_CHOICES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `feed-tile-permission-btn feed-tile-permission-btn-${choice}`;
    btn.dataset.choice = choice;
    const btnIcon = document.createElement("i");
    btnIcon.className = `ph ${iconClass}`;
    btn.appendChild(btnIcon);
    const btnLabel = document.createElement("span");
    btnLabel.textContent = label;
    btn.appendChild(btnLabel);
    btn.addEventListener("click", () => submitPermissionChoice(msg.requestId, choice, cards));
    buttonsEl.appendChild(btn);
    buttons.push(btn);
  }
  row.appendChild(buttonsEl);

  const status = document.createElement("div");
  status.className = "feed-tile-permission-status";
  row.appendChild(status);

  return { row, buttons, status, resolved: false };
}

async function submitPermissionChoice(requestId, choice, cards) {
  const card = cards.get(requestId);
  if (!card || card.resolved) return;

  // Disable the whole button row immediately so a double-click can't
  // double-post — the server already de-dupes via single-shot resolve,
  // but the UI should reflect pending state without waiting for the
  // round-trip.
  for (const b of card.buttons) b.disabled = true;
  card.status.textContent = "Sending…";
  card.status.className = "feed-tile-permission-status";

  try {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const headers = { "Content-Type": "application/json" };
    if (csrfMeta?.content) headers["X-CSRF-Token"] = csrfMeta.content;
    const res = await fetch("/api/claude/permission", {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId, choice }),
      credentials: "same-origin",
      redirect: "error",
    });
    if (!res.ok) {
      let msg = `Send failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    // Success path — leave the card disabled. The permission-resolved
    // event the server publishes will call markPermissionResolved, which
    // stamps the chosen label into `.feed-tile-permission-status`.
  } catch (err) {
    card.status.textContent = err.message || "Send failed";
    card.status.classList.add("feed-tile-permission-status-error");
    // Re-enable buttons so the user can retry — except dismiss, which
    // just hides the card locally and doesn't benefit from retry logic.
    for (const b of card.buttons) {
      if (b.dataset.choice !== "dismiss") b.disabled = false;
    }
  }
}

function markPermissionResolved(card, choice) {
  if (card.resolved) return;
  card.resolved = true;
  card.row.classList.add("is-resolved");
  for (const b of card.buttons) {
    b.disabled = true;
    if (b.dataset.choice === choice) b.classList.add("is-chosen");
  }
  const label = PERMISSION_CHOICES.find((c) => c.choice === choice)?.label;
  card.status.textContent = label ? `Resolved: ${label}` : "Resolved";
  card.status.classList.remove("feed-tile-permission-status-error");
}

function renderReplyBody(entry) {
  if (!entry.msg) return;
  entry.body.innerHTML = "";
  renderMarkdown(entry.body, entry.msg.step || "");
  enrichFeedProse(entry.body);
}

function renderReplyFooter(entry) {
  entry.footer.innerHTML = "";
  entry.footer.appendChild(makeTimeSpan(entry.ts));
  const msg = entry.msg;
  if (msg && Array.isArray(msg.files) && msg.files.length > 0) {
    const files = document.createElement("span");
    files.className = "feed-tile-reply-files";
    for (const f of msg.files) files.appendChild(makeFileChip(f));
    entry.footer.appendChild(files);
  }
  if (entry.tools.size > 0) {
    const n = entry.tools.size;
    const count = document.createElement("span");
    count.className = "feed-tile-reply-tool-count";
    count.textContent = `${n} step${n === 1 ? "" : "s"}`;
    entry.footer.appendChild(count);
    const chev = document.createElement("span");
    chev.className = "feed-tile-reply-chevron";
    chev.innerHTML = '<i class="ph ph-caret-down"></i>';
    entry.footer.appendChild(chev);
  }
}

// Tool card. Collapsed by default — just the header row showing
// name + target + state — taps expand to reveal the full output. The
// state class (`feed-tile-tool--running|ok|error`) drives the border
// style (animated / green / red) so the user can scan a long feed and
// see at a glance which tool calls are still in flight and which
// completed, without opening every card.
//
// The row is rebuilt on every update (running → ok/error) because the
// output payload only lands on the terminal tool_result event —
// holding a reference to the inner body and mutating it would mean
// threading more state through handleEvent than it's worth.
//
// `info.target` is pre-computed server-side (see toolTargetLabel in
// claude-event-transform.js) so this renderer stays ignorant of
// Claude's tool input shapes.
function renderToolItem(row, info, ts) {
  row.innerHTML = "";
  const state = info.state === "ok" || info.state === "error" ? info.state : "running";
  row.className = `feed-tile-item feed-status-tool feed-tile-tool--${state}`;

  const details = document.createElement("details");
  details.className = "feed-tile-tool";

  const header = document.createElement("summary");

  const name = document.createElement("span");
  name.className = "feed-tile-tool-name";
  name.textContent = info.name || "Tool";
  header.appendChild(name);

  if (typeof info.target === "string" && info.target) {
    const tgt = document.createElement("span");
    tgt.className = "feed-tile-tool-target";
    tgt.textContent = info.target;
    header.appendChild(tgt);
  }

  const stateLabel = document.createElement("span");
  stateLabel.className = "feed-tile-tool-state";
  stateLabel.textContent = state;
  header.appendChild(stateLabel);

  header.appendChild(makeTimeSpan(ts));
  details.appendChild(header);

  const body = document.createElement("div");
  body.className = "feed-tile-tool-body";
  if (typeof info.output === "string" && info.output) {
    const pre = document.createElement("pre");
    pre.className = "feed-tile-tool-output";
    pre.textContent = info.output;
    body.appendChild(pre);
  } else if (state === "running") {
    const hint = document.createElement("div");
    hint.className = "feed-tile-tool-hint";
    hint.textContent = "Running\u2026";
    body.appendChild(hint);
  }
  details.appendChild(body);
  row.appendChild(details);
}

// The user's side of the conversation. Same structural shape as a
// reply (body + time footer) but styled differently so the reader
// can eyeball the back-and-forth without reading every word.
function renderPromptItem(row, msg, ts) {
  row.innerHTML = "";
  row.className = "feed-tile-item feed-status-prompt";
  const text = msg.step || "";

  const prose = document.createElement("div");
  prose.className = "feed-tile-prompt-body";
  renderMarkdown(prose, text);
  enrichFeedProse(prose);
  row.appendChild(prose);

  const footer = document.createElement("div");
  footer.className = "feed-tile-prompt-footer";
  footer.appendChild(makeTimeSpan(ts));
  row.appendChild(footer);
}

function renderLogItem(row, msg, ts) {
  row.innerHTML = "";
  row.className = "feed-tile-item feed-log-item";

  const time = document.createElement("span");
  time.className = "feed-tile-time";
  time.textContent = new Date(ts).toLocaleTimeString();
  row.appendChild(time);

  const text = document.createElement("span");
  text.className = "feed-tile-text";
  text.textContent = typeof msg === "string" ? msg : JSON.stringify(msg);
  row.appendChild(text);
}

// ── Renderer ────────────────────────────────────────────────────────

export const feedRenderer = {
  type: "feed",

  init() {},

  describe(props) {
    return {
      title: props.title || props.topic || "Feed",
      icon: "rss",
      persistable: true,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    let mounted = true;
    let es = null;
    // Drained on view transitions (picker → streaming) so stale window
    // listeners don't accumulate.
    let viewCleanups = [];
    function drainViewCleanups() {
      const fns = viewCleanups;
      viewCleanups = [];
      for (const fn of fns) { try { fn(); } catch { /* ignore */ } }
    }

    const root = document.createElement("div");
    root.className = "feed-tile-root";
    el.appendChild(root);

    function buildStreamHeader(titleText, { claudeUuid = null, topic = null } = {}) {
      const header = document.createElement("div");
      header.className = "feed-tile-header";

      const backBtn = document.createElement("button");
      backBtn.className = "feed-tile-back-btn";
      backBtn.innerHTML = '<i class="ph ph-arrow-left"></i>';
      backBtn.title = "Back to topics";
      backBtn.addEventListener("click", () => { if (mounted) showTopicPicker(); });
      header.appendChild(backBtn);

      const headerTitle = document.createElement("span");
      headerTitle.className = "feed-tile-header-title";
      headerTitle.textContent = titleText;
      header.appendChild(headerTitle);

      // Jump to (or spawn) the terminal session running this Claude
      // transcript. The feed tile doesn't own the UI store, so this just
      // announces intent — app.js owns the find-or-create decision
      // (focus existing tile / add tile for live session / create new
      // session with cwd + `claude --resume`). Rendered only for claude
      // topics since only they have a uuid worth resuming.
      if (claudeUuid) {
        const openTerminalBtn = document.createElement("button");
        openTerminalBtn.className = "feed-tile-open-terminal-btn";
        openTerminalBtn.innerHTML = '<i class="ph ph-terminal-window"></i>';
        openTerminalBtn.title = "Open terminal session";
        openTerminalBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          window.dispatchEvent(new CustomEvent("katulong:open-terminal-for-uuid", {
            detail: { uuid: claudeUuid, topic },
          }));
        });
        header.appendChild(openTerminalBtn);
      }

      const closeBtn = document.createElement("button");
      closeBtn.className = "feed-tile-close-btn";
      closeBtn.innerHTML = '<i class="ph ph-x"></i>';
      closeBtn.title = "Close";
      closeBtn.addEventListener("click", () => ctx?.requestClose?.());
      header.appendChild(closeBtn);

      return { header };
    }

    try {
      if (props.topic) {
        startStreaming(props.topic, props.meta || {});
      } else {
        showTopicPicker();
      }
    } catch (err) {
      root.textContent = "Feed error: " + err.message;
    }

    // ── Topic picker (inline) ───────────────────────────────────
    function showTopicPicker() {
      if (es) { es.close(); es = null; }
      drainViewCleanups();
      root.innerHTML = "";

      const selected = new Set(props.checked || []);

      if (dispatch) {
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { topic: null, title: "Feed", meta: {} } });
      }

      const picker = document.createElement("div");
      picker.className = "feed-tile-picker";

      const header = document.createElement("div");
      header.className = "feed-tile-picker-title";

      const titleText = document.createElement("span");
      titleText.textContent = "Subscribe to a topic";
      header.appendChild(titleText);

      const closeBtn = document.createElement("button");
      closeBtn.className = "feed-tile-picker-close-btn";
      closeBtn.innerHTML = '<i class="ph ph-x"></i>';
      closeBtn.title = "Close";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        ctx?.requestClose?.();
      });
      header.appendChild(closeBtn);

      picker.appendChild(header);

      const listArea = document.createElement("div");
      listArea.className = "feed-tile-picker-list";
      listArea.textContent = "Loading topics\u2026";
      picker.appendChild(listArea);

      const actionBar = document.createElement("div");
      actionBar.className = "feed-tile-picker-actionbar";
      actionBar.style.display = "none";
      picker.appendChild(actionBar);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "feed-tile-picker-delete-btn";
      deleteBtn.innerHTML = '<i class="ph ph-trash"></i> Delete';
      actionBar.appendChild(deleteBtn);

      root.appendChild(picker);

      function updateToolbar() {
        const count = selected.size;
        actionBar.style.display = count > 0 ? "" : "none";
        deleteBtn.innerHTML = count === 1
          ? '<i class="ph ph-trash"></i> Delete'
          : `<i class="ph ph-trash"></i> Delete ${count}`;
      }

      async function deleteSelected() {
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Deleting\u2026";
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        const headers = { "Content-Type": "application/json" };
        if (csrf) headers["x-csrf-token"] = csrf;

        for (const topic of selected) {
          try {
            await fetch(`/api/topics/${encodeURIComponent(topic)}`, {
              method: "DELETE", credentials: "same-origin", redirect: "error", headers,
            });
          } catch { /* continue with others */ }
        }
        if (dispatch) {
          dispatch({ type: "ui/UPDATE_PROPS", id, patch: { checked: [] } });
        }
        showTopicPicker();
      }

      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSelected();
      });

      const knownTopics = new Set();
      let emptyEl = null;

      function createTopicItem(t) {
        if (knownTopics.has(t.name)) return;
        knownTopics.add(t.name);

        if (emptyEl) { emptyEl.remove(); emptyEl = null; }

        const item = document.createElement("div");
        item.className = "feed-tile-picker-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "feed-tile-picker-cb";
        cb.addEventListener("click", (e) => e.stopPropagation());
        if (selected.has(t.name)) {
          cb.checked = true;
          item.classList.add("selected");
        }
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(t.name); else selected.delete(t.name);
          item.classList.toggle("selected", cb.checked);
          updateToolbar();
          if (dispatch) {
            dispatch({ type: "ui/UPDATE_PROPS", id, patch: { checked: [...selected] } });
          }
        });
        item.appendChild(cb);

        const name = document.createElement("span");
        name.className = "feed-tile-picker-name";
        name.textContent = t.name;
        item.appendChild(name);

        const info = document.createElement("span");
        info.className = "feed-tile-picker-info";
        const parts = [];
        if (t.meta && t.meta.type) parts.push(t.meta.type);
        parts.push(`${t.messages || 0} msgs`);
        info.textContent = parts.join(" \u00b7 ");
        item.appendChild(info);

        item.addEventListener("click", () => {
          if (!mounted) return;
          if (dispatch) {
            dispatch({ type: "ui/UPDATE_PROPS", id, patch: { topic: t.name, title: t.name, meta: t.meta || {} } });
          }
          startStreaming(t.name, t.meta || {});
        });

        listArea.appendChild(item);
      }

      function onTopicNew(e) {
        if (!mounted) return;
        createTopicItem({ name: e.detail.topic, meta: e.detail.meta, messages: 0 });
      }
      window.addEventListener("katulong:topic-new", onTopicNew);
      viewCleanups.push(() => window.removeEventListener("katulong:topic-new", onTopicNew));

      fetch("/api/topics", { credentials: "same-origin", redirect: "error" })
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
        .then(topics => {
          if (!mounted) return;
          listArea.textContent = "";

          if (topics.length > 0) {
            for (const t of topics) createTopicItem(t);
          } else {
            emptyEl = document.createElement("div");
            emptyEl.className = "feed-tile-picker-empty";
            emptyEl.textContent = "No topics yet. Publish events to create one.";
            listArea.appendChild(emptyEl);
          }

          let pruned = false;
          for (const name of selected) {
            if (!knownTopics.has(name)) { selected.delete(name); pruned = true; }
          }
          if (pruned && dispatch) {
            dispatch({ type: "ui/UPDATE_PROPS", id, patch: { checked: [...selected] } });
          }
          updateToolbar();
        });
    }

    // ── Streaming view ──────────────────────────────────────────
    function startStreaming(topic, meta) {
      if (es) { es.close(); es = null; }
      drainViewCleanups();
      root.innerHTML = "";
      const topicMeta = meta || {};

      // Claude-topic extraction. `claudeUuid` drives two pieces of the
      // header chrome: the response bar (pinned textarea) and the
      // open-terminal button. Compute it up-front so buildStreamHeader
      // can render the terminal button without knowing the topic format.
      const claudeUuid = (() => {
        if (!topic.startsWith("claude/")) return null;
        const u = topic.slice("claude/".length);
        return UUID_RE.test(u) ? u : null;
      })();

      const { header } = buildStreamHeader(topic, { claudeUuid, topic });
      root.appendChild(header);

      const list = document.createElement("div");
      list.className = "feed-tile-list";
      list.tabIndex = 0;
      root.appendChild(list);

      // Reply/prompt entries are keyed by their transcript entry uuid so
      // a republished turn (e.g. after a processor catch-up) updates the
      // existing card in place rather than duplicating it. Each value is
      // `{ kind: "reply"|"prompt", ... }` — reply entries carry the full
      // block structure (header/body/footer/toolsEl + tools map); prompt
      // entries are just `{ kind: "prompt", row }`.
      const entryItems = new Map();
      // Most recent reply entryId — tools that arrive after it fold into
      // its nested tool list. Stays null until the first reply lands.
      let activeReplyId = null;
      // Tool cards are keyed by their tool_use id. A running card is
      // stamped on the tool_use event; the matching tool_result event
      // flips state (ok/error) and fills the output body. Values hold
      // the merged info so an out-of-order republish (running event
      // delivered AFTER its result, e.g. during a catch-up slice)
      // doesn't clobber the terminal state. `ownerReplyId` records the
      // reply the tool was folded into — null means the tool landed
      // before any reply and is currently shown as a top-level orphan.
      const toolItems = new Map();
      // Permission-request menu cards, keyed by requestId. A card lives
      // in the feed as an inline row between replies — appending lets it
      // sort alongside whatever else is landing. On resolve we dim
      // instead of removing so the reader has a local record that the
      // question was answered (and doesn't mistake it for unanswered).
      const permissionCards = new Map();
      // Ephemeral non-reply events (generic log topics or pre-rewrite
      // persisted events) get auto-keyed row slots.
      const logItems = new Map();
      let autoKey = 0;
      const isProgress = topicMeta.type === "progress";

      // Response bar — only for claude/<uuid> topics. Lets the user
      // type back to the Claude session without leaving the feed, and
      // offers quick-pick buttons when the latest reply ends in a
      // numbered options list.
      const responseBar = claudeUuid ? createResponseBar(claudeUuid) : null;

      // Pinned summary at the top of the list. Rendered only for
      // claude topics; hidden until the first `session-summary`
      // event lands. Uses a native <details> so the user can
      // collapse the card out of the way — when closed only the
      // compact header row stays pinned to the top of the feed,
      // giving replies more vertical real estate. `short` shows
      // in the body; `long` is held on a data-attribute so a
      // future surface (tooltip, expand) can read it.
      const summaryCard = isProgress && claudeUuid ? document.createElement("details") : null;
      let summaryBody = null;
      if (summaryCard) {
        summaryCard.className = "feed-tile-summary-card";
        summaryCard.open = true;
        summaryCard.style.display = "none";
        const summaryHeader = document.createElement("summary");
        summaryHeader.textContent = "Session summary";
        summaryBody = document.createElement("div");
        summaryBody.className = "feed-tile-summary-body";
        summaryCard.appendChild(summaryHeader);
        summaryCard.appendChild(summaryBody);
        list.appendChild(summaryCard);
      }
      function applySummary(msg) {
        if (!summaryCard) return;
        const short = typeof msg.short === "string" ? msg.short.trim() : "";
        if (!short) { summaryCard.style.display = "none"; return; }
        summaryCard.style.display = "";
        summaryCard.dataset.long = typeof msg.long === "string" ? msg.long : "";
        summaryBody.textContent = short;
      }

      function handleEvent(envelope) {
        let msg;
        try { msg = JSON.parse(envelope.message); } catch { msg = envelope.message; }
        if (!msg || typeof msg !== "object") return;

        const status = msg.status || "";

        // Progress-shaped topics render one thing: a flat reply card per
        // assistant turn. Legacy events (narrative, summary, attention,
        // completion, reply-title) still sitting in old topic logs are
        // silently dropped.
        if (isProgress) {
          if (status === "session-summary") {
            applySummary(msg);
            return;
          }
          if (status === "permission-request" && typeof msg.requestId === "string") {
            // Already rendered? (duplicate publish, e.g. on reconnect) — no-op.
            if (permissionCards.has(msg.requestId)) return;
            const card = renderPermissionCard(msg, claudeUuid, permissionCards);
            list.appendChild(card.row);
            permissionCards.set(msg.requestId, card);
            list.scrollTop = list.scrollHeight;
            return;
          }
          if (status === "permission-resolved" && typeof msg.requestId === "string") {
            const card = permissionCards.get(msg.requestId);
            if (card) markPermissionResolved(card, msg.choice);
            return;
          }
          if (status === "tool" && typeof msg.toolUseId === "string") {
            const existing = toolItems.get(msg.toolUseId);
            let entry;
            if (!existing) {
              const row = document.createElement("div");
              entry = { row, info: { ...msg }, ownerReplyId: null };
              toolItems.set(msg.toolUseId, entry);
              // Fold into the active reply if one has landed; otherwise
              // show as an orphan at the top of the list and adopt it
              // when the first reply arrives. In practice Claude always
              // emits a preamble reply before running tools, so orphan
              // tools are rare (early-start slices, mostly).
              if (activeReplyId && entryItems.has(activeReplyId)) {
                const owner = entryItems.get(activeReplyId);
                owner.toolsEl.appendChild(row);
                owner.tools.set(msg.toolUseId, msg.state || "running");
                entry.ownerReplyId = activeReplyId;
                renderReplyFooter(owner);
                applyReplyClasses(owner);
              } else {
                list.appendChild(row);
              }
            } else {
              entry = existing;
              // Merge so running metadata (name/input, stamped first)
              // survives when a later ok/error event carries only the
              // output — and conversely, a running republish doesn't
              // drop a terminal state that already landed. Snapshot
              // prev BEFORE the spread since `entry.info` is the object
              // being overwritten.
              const prevState = entry.info.state;
              const prevOutput = entry.info.output;
              const wasTerminal = prevState === "ok" || prevState === "error";
              const isTerminal = msg.state === "ok" || msg.state === "error";
              entry.info = { ...entry.info, ...msg };
              if (wasTerminal && !isTerminal) {
                entry.info.state = prevState;
                if (typeof prevOutput === "string") entry.info.output = prevOutput;
              }
              // Mirror the merged state into the owning reply so its
              // is-running / tool-count indicators stay accurate.
              if (entry.ownerReplyId && entryItems.has(entry.ownerReplyId)) {
                const owner = entryItems.get(entry.ownerReplyId);
                owner.tools.set(msg.toolUseId, entry.info.state);
                applyReplyClasses(owner);
              }
            }
            renderToolItem(entry.row, entry.info, envelope.timestamp);
            list.scrollTop = list.scrollHeight;
            return;
          }
          if (status === "reply" && typeof msg.entryId === "string") {
            let entry = entryItems.get(msg.entryId);
            const firstRender = !entry || entry.kind !== "reply";
            if (firstRender) {
              entry = createReplyEntry();
              entryItems.set(msg.entryId, entry);
              list.appendChild(entry.block);
              // Adopt any orphan tools that landed before this reply.
              for (const [toolUseId, toolEntry] of toolItems) {
                if (!toolEntry.ownerReplyId) {
                  toolEntry.ownerReplyId = msg.entryId;
                  entry.toolsEl.appendChild(toolEntry.row);
                  entry.tools.set(toolUseId, toolEntry.info.state || "running");
                }
              }
              // Deactivate the prior reply — it stops pulsing, collapses
              // its tools, and makes room for the new one to claim the
              // "current work" border. Tapping a prior reply later still
              // re-expands it.
              if (activeReplyId && entryItems.has(activeReplyId)) {
                const prior = entryItems.get(activeReplyId);
                if (prior.kind === "reply") {
                  prior.isActive = false;
                  prior.expanded = false;
                  applyReplyClasses(prior);
                }
              }
              activeReplyId = msg.entryId;
              entry.isActive = true;
              entry.expanded = true;
            }
            entry.msg = msg;
            entry.ts = envelope.timestamp;
            renderReplyBody(entry);
            renderReplyFooter(entry);
            applyReplyClasses(entry);
            // Re-evaluate quick-pick options from the latest reply. The
            // "latest" is always the most recent publish on the topic
            // log — for a live stream that's also the last message
            // rendered, so we can just feed this reply's text in. (If
            // a replay delivers an OLDER reply after a newer one, the
            // options list might flicker; accepted tradeoff for not
            // maintaining a full ordered index client-side.)
            if (responseBar) responseBar.setOptions(msg.step || "");
          } else if (status === "prompt" && typeof msg.entryId === "string") {
            let entry = entryItems.get(msg.entryId);
            if (!entry || entry.kind !== "prompt") {
              const row = document.createElement("div");
              list.appendChild(row);
              entry = { kind: "prompt", row };
              entryItems.set(msg.entryId, entry);
            }
            renderPromptItem(entry.row, msg, envelope.timestamp);
          }
          list.scrollTop = list.scrollHeight;
          return;
        }

        // Generic log-topic mode: one row per event, chronological.
        const key = `_evt_${autoKey++}`;
        let row = logItems.get(key);
        if (!row) {
          row = document.createElement("div");
          list.appendChild(row);
          logItems.set(key, row);
        }
        renderLogItem(row, msg, envelope.timestamp);
        list.scrollTop = list.scrollHeight;
      }

      // Append the response bar AFTER the list, outside scrollable area
      // so it stays pinned while the list scrolls with new replies.
      if (responseBar) root.appendChild(responseBar.el);

      // Empty-state: shown until the first envelope arrives. EventSource
      // opens asynchronously, so on a successful stream the user sees this
      // for a few ms; on a failing stream (e.g. claude/<uuid> no longer on
      // the watchlist because staging data was wiped) it stays — hence the
      // hint. For Claude topics we word it as a recovery prompt; generic
      // topics just say "no events yet".
      const emptyHint = document.createElement("div");
      emptyHint.className = "feed-tile-empty-hint";
      emptyHint.textContent = topic.startsWith("claude/")
        ? "Waiting for Claude narration\u2026 open this feed from a session's sparkle button if it stays blank."
        : "No events yet.";
      list.appendChild(emptyHint);
      function clearEmptyHint() {
        if (emptyHint.parentNode) emptyHint.remove();
      }

      es = new EventSource(streamUrlForTopic(topic));
      es.onmessage = (event) => {
        if (!mounted) return;
        clearEmptyHint();
        try {
          handleEvent(JSON.parse(event.data));
        } catch { /* ignore malformed */ }
      };
      // On connection failure (404 from /api/claude/stream, network drop,
      // etc.) the browser auto-retries. Swap the hint for an explicit
      // failure message so the user isn't staring at a frozen placeholder.
      es.onerror = () => {
        if (!mounted) return;
        if (!emptyHint.parentNode) return; // events already flowed
        emptyHint.textContent = topic.startsWith("claude/")
          ? "Couldn't open Claude narration. Open the feed from a session's sparkle button to re-subscribe."
          : "Couldn't open stream.";
        emptyHint.classList.add("feed-tile-empty-hint-error");
      };
    }

    // ── Handle ──────────────────────────────────────────────────
    return {
      unmount() {
        mounted = false;
        if (es) es.close();
        drainViewCleanups();
        el.innerHTML = "";
      },
      focus() {
        const list = root.querySelector(".feed-tile-list");
        if (list) list.focus();
      },
      blur() {},
      resize() {},
      getSessions() { return []; },
      tile: null,
    };
  },
};
