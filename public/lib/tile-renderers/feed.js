/**
 * Feed Tile Renderer
 *
 * Subscribes to a pub/sub topic via SSE and renders events according to
 * topic metadata. Pure subscriber — no knowledge of who produces events.
 *
 * Routing:
 *   - `claude/<uuid>` topics stream via `/api/claude/stream/:uuid`. That
 *     endpoint acquires a per-UUID processor refcount for the lifetime of
 *     the connection, so transcript polling + Ollama enrichment only run
 *     while the tile is open. Opt-in (POST /api/claude/watch) happens
 *     elsewhere — typically the sparkle-click handler in app.js.
 *   - Any other topic streams via `/sub/<topic>`, the generic broker SSE.
 *
 * Event shapes (progress topics):
 *   reply        — { status, entryId, step, ts } — a whole Claude reply,
 *                  rendered as a <details> block: collapsed label shows the
 *                  time + (title || "Claude's reply (N words)"); expanded
 *                  body shows the full text.
 *   reply-title  — { status, entryId, title } — progressive-enhancement
 *                  patch from the Ollama title generator. Finds the reply
 *                  card with the same entryId and swaps in the title.
 *
 * Lifecycle:
 *   1. Mount with `props.topic` → stream immediately.
 *   2. Mount without → inline topic picker (from /api/topics).
 *   3. Rendering strategy chosen by `props.meta.type`:
 *        "progress" — Claude reply cards with optional Ollama titles.
 *        default    — chronological event log with timestamps.
 */

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

// Label shown inside the collapsed <summary> before (or in the absence of)
// an Ollama-generated title. The time span is added separately, outside
// the label, so it stays aligned even as the label text swaps in.
function replyFallbackLabel(text) {
  const words = typeof text === "string" && text.trim()
    ? text.trim().split(/\s+/).length
    : 0;
  return words
    ? `Claude's reply (${words} word${words === 1 ? "" : "s"})`
    : "Claude's reply";
}

// File chips shown inline on the collapsed summary — clicking one
// dispatches a window CustomEvent that app.js catches to open the file
// in a document tile (same path as a file link clicked in the terminal).
function makeFileChip(file) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "feed-tile-reply-file";
  // basename for display, full path in the title + click payload
  const base = (file.path || "").split("/").filter(Boolean).pop() || file.path;
  chip.textContent = file.line ? `${base}:${file.line}` : base;
  chip.title = file.line ? `${file.path}:${file.line}` : file.path;
  chip.addEventListener("click", (ev) => {
    // Prevent the click from toggling the <details> open/closed.
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

  const summary = document.createElement("summary");
  summary.className = "feed-tile-reply-summary";
  // Time lives inside <summary> so it stays visible when the reply is
  // collapsed — <details> hides everything below the first <summary>.
  summary.appendChild(makeTimeSpan(ts));
  const label = document.createElement("span");
  label.className = "feed-tile-reply-label";
  label.textContent = typeof msg.title === "string" && msg.title
    ? msg.title
    : replyFallbackLabel(text);
  summary.appendChild(label);

  if (Array.isArray(msg.files) && msg.files.length > 0) {
    const files = document.createElement("span");
    files.className = "feed-tile-reply-files";
    for (const f of msg.files) files.appendChild(makeFileChip(f));
    summary.appendChild(files);
  }

  row.appendChild(summary);

  const prose = document.createElement("div");
  prose.className = "feed-tile-reply-body";
  prose.textContent = text;
  row.appendChild(prose);
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
      // later `reply-title` enrichment event can find and patch the same
      // <details> node in place without rebuilding it.
      const replyItems = new Map();
      // Pending titles that arrived BEFORE their reply card (shouldn't
      // happen within a single topic — the processor publishes reply
      // first — but cheap insurance across reconnects and replays).
      const pendingTitles = new Map();
      // Ephemeral non-reply events (generic log topics or pre-rewrite
      // persisted events) get auto-keyed row slots.
      const logItems = new Map();
      let autoKey = 0;
      const isProgress = topicMeta.type === "progress";

      function applyTitle(entryId, title) {
        const row = replyItems.get(entryId);
        if (!row) {
          pendingTitles.set(entryId, title);
          return;
        }
        const label = row.querySelector(".feed-tile-reply-label");
        if (label) label.textContent = title;
      }

      function handleEvent(envelope) {
        let msg;
        try { msg = JSON.parse(envelope.message); } catch { msg = envelope.message; }
        if (!msg || typeof msg !== "object") return;

        const status = msg.status || "";

        // Progress-shaped topics only render two things — a reply card and
        // its (optional, late-arriving) Ollama title. Everything else that
        // might still be sitting in an old topic log (narrative, summary,
        // attention, completion from the old narrator) is silently ignored.
        if (isProgress) {
          if (status === "reply" && typeof msg.entryId === "string") {
            let row = replyItems.get(msg.entryId);
            if (!row) {
              row = document.createElement("details");
              list.appendChild(row);
              replyItems.set(msg.entryId, row);
            }
            const pending = pendingTitles.get(msg.entryId);
            if (pending && !msg.title) {
              msg.title = pending;
              pendingTitles.delete(msg.entryId);
            }
            renderReplyItem(row, msg, envelope.timestamp);
          } else if (status === "reply-title" && typeof msg.entryId === "string" && msg.title) {
            applyTitle(msg.entryId, msg.title);
          }
          // Silent drop for any other status.
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
