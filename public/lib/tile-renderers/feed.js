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

// A pinned-to-bottom composer for Claude topics. Shows quick-pick
// buttons when the latest reply ends in a numbered options list, plus
// a textarea + Send button for typed responses.
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
  textarea.placeholder = "Reply to Claude — Enter to send, Shift+Enter for newline";
  el.appendChild(textarea);

  const status = document.createElement("div");
  status.className = "feed-tile-response-status";
  el.appendChild(status);

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
      const res = await fetch(`/api/claude/respond/${encodeURIComponent(claudeUuid)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
        credentials: "same-origin",
        redirect: "error",
      });
      if (!res.ok) {
        let msg = `Send failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      textarea.value = "";
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
      btn.addEventListener("click", () => send(opt.key));
      optionsRow.appendChild(btn);
    }
  }

  return { el, setOptions };
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

function renderReplyItem(row, msg, ts) {
  row.innerHTML = "";
  row.className = "feed-tile-item feed-status-reply";
  const text = msg.step || "";

  // Prose first, metadata below — the reply IS the content. The footer
  // is reference material (when it happened, what it touched) that a
  // reader glances at after skimming the body.
  const prose = document.createElement("div");
  prose.className = "feed-tile-reply-body";
  renderMarkdown(prose, text);
  row.appendChild(prose);

  const footer = document.createElement("div");
  footer.className = "feed-tile-reply-footer";
  footer.appendChild(makeTimeSpan(ts));
  if (Array.isArray(msg.files) && msg.files.length > 0) {
    const files = document.createElement("span");
    files.className = "feed-tile-reply-files";
    for (const f of msg.files) files.appendChild(makeFileChip(f));
    footer.appendChild(files);
  }
  row.appendChild(footer);
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

    function buildStreamHeader(titleText) {
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

      const { header } = buildStreamHeader(topic);
      root.appendChild(header);

      const list = document.createElement("div");
      list.className = "feed-tile-list";
      list.tabIndex = 0;
      root.appendChild(list);

      // Reply cards are keyed by their transcript entry uuid so that a
      // republished reply (e.g. after a processor catch-up) updates the
      // existing row in place rather than duplicating it.
      const replyItems = new Map();
      // Ephemeral non-reply events (generic log topics or pre-rewrite
      // persisted events) get auto-keyed row slots.
      const logItems = new Map();
      let autoKey = 0;
      const isProgress = topicMeta.type === "progress";

      // Response bar — only for claude/<uuid> topics. Lets the user
      // type back to the Claude session without leaving the feed, and
      // offers quick-pick buttons when the latest reply ends in a
      // numbered options list.
      const claudeUuid = (() => {
        if (!topic.startsWith("claude/")) return null;
        const u = topic.slice("claude/".length);
        return UUID_RE.test(u) ? u : null;
      })();
      const responseBar = claudeUuid ? createResponseBar(claudeUuid) : null;

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
          if (status === "reply" && typeof msg.entryId === "string") {
            let row = replyItems.get(msg.entryId);
            if (!row) {
              row = document.createElement("div");
              list.appendChild(row);
              replyItems.set(msg.entryId, row);
            }
            renderReplyItem(row, msg, envelope.timestamp);
            // Re-evaluate quick-pick options from the latest reply. The
            // "latest" is always the most recent publish on the topic
            // log — for a live stream that's also the last message
            // rendered, so we can just feed this reply's text in. (If
            // a replay delivers an OLDER reply after a newer one, the
            // options list might flicker; accepted tradeoff for not
            // maintaining a full ordered index client-side.)
            if (responseBar) responseBar.setOptions(msg.step || "");
          } else if (status === "prompt" && typeof msg.entryId === "string") {
            // Share the same items map as replies — entryId space is
            // per-transcript and doesn't collide, and keying both lets
            // a republished prompt update its row in place just like
            // replies do.
            let row = replyItems.get(msg.entryId);
            if (!row) {
              row = document.createElement("div");
              list.appendChild(row);
              replyItems.set(msg.entryId, row);
            }
            renderPromptItem(row, msg, envelope.timestamp);
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
