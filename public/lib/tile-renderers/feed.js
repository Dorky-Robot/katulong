/**
 * Feed Tile Renderer
 *
 * General-purpose event streamer that subscribes to a pub/sub topic via
 * SSE and renders events according to topic metadata. The tile is a
 * subscriber — it decides how to display raw domain events. Another
 * subscriber (an orchestrator) could use the same events for choreography.
 *
 * Lifecycle:
 *   1. Opens blank with an inline topic picker (fetched from /api/topics)
 *   2. User picks a topic → tile starts streaming via SSE
 *   3. Rendering strategy chosen by topic meta.type (closed enumeration —
 *      not an extension point; new strategies require an in-tree PR):
 *      - "progress" — checklist with keyed step updates + status bullets
 *      - default    — chronological event log with timestamps
 *
 * Single-file renderer: no factory, no init deps.
 */

// ── Rendering strategies ────────────────────────────────────────────

function renderProgressItem(row, msg) {
  row.innerHTML = "";
  const status = msg.status || "info";
  row.className = `feed-tile-item feed-status-${status}`;

  // Assistant text renders as a standalone narrative block
  if (status === "text") {
    const text = document.createElement("span");
    text.className = "feed-tile-step feed-tile-assistant-text";
    text.textContent = msg.step || "";
    row.appendChild(text);
    return;
  }

  const bullet = document.createElement("span");
  bullet.className = "feed-tile-bullet";
  bullet.textContent = status === "done" ? "\u25CF"
    : status === "active" ? "\u25C9"
    : status === "error" ? "\u2715"
    : status === "pending" ? "\u25CB"
    : "\u2022";
  row.appendChild(bullet);

  const text = document.createElement("span");
  text.className = "feed-tile-step";
  text.textContent = msg.step || msg.detail || JSON.stringify(msg);
  row.appendChild(text);

  if (msg.detail && msg.step) {
    const detail = document.createElement("div");
    detail.className = "feed-tile-detail";
    detail.textContent = msg.detail;
    row.appendChild(detail);
  }
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

  init(_deps) {},

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
    const cleanups = [];

    const root = document.createElement("div");
    root.className = "feed-tile-root";
    el.appendChild(root);

    // If we already have a topic (e.g. restored from persistence), go
    // straight to streaming. Otherwise show the inline topic picker.
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
      root.innerHTML = "";

      // Restore checked state from persisted props
      const selected = new Set(props.checked || []);

      // Clear persisted topic so we're back to picker state (keep checked)
      if (dispatch) {
        dispatch({ type: "ui/UPDATE_PROPS", id, patch: { topic: null, title: "Feed", meta: {} } });
      }

      const picker = document.createElement("div");
      picker.className = "feed-tile-picker";

      // Header row with title + toolbar
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

      // Bottom action bar — visible only when items are checked
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
        // Clear deleted topics from persisted checked state
        if (dispatch) {
          dispatch({ type: "ui/UPDATE_PROPS", id, patch: { checked: [] } });
        }
        showTopicPicker();
      }

      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSelected();
      });

      // Track known topic names so we don't add duplicates on live updates
      const knownTopics = new Set();
      let emptyEl = null;

      function createTopicItem(t) {
        if (knownTopics.has(t.name)) return;
        knownTopics.add(t.name);

        // Remove "no topics" placeholder if present
        if (emptyEl) { emptyEl.remove(); emptyEl = null; }

        const item = document.createElement("div");
        item.className = "feed-tile-picker-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "feed-tile-picker-cb";
        cb.addEventListener("click", (e) => e.stopPropagation());
        // Restore checked state from persisted selection
        if (selected.has(t.name)) {
          cb.checked = true;
          item.classList.add("selected");
        }
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(t.name); else selected.delete(t.name);
          item.classList.toggle("selected", cb.checked);
          updateToolbar();
          // Persist checked state to tile props
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

      // Listen for new topics via WebSocket
      function onTopicNew(e) {
        if (!mounted) return;
        createTopicItem({ name: e.detail.topic, meta: e.detail.meta, messages: 0 });
      }
      window.addEventListener("katulong:topic-new", onTopicNew);
      cleanups.push(() => window.removeEventListener("katulong:topic-new", onTopicNew));

      // Fetch existing topics
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

          // Prune stale topic names that no longer exist on the server
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
      root.innerHTML = "";
      const topicMeta = meta || {};

      // Header
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
      headerTitle.textContent = topic;
      header.appendChild(headerTitle);

      const closeBtn = document.createElement("button");
      closeBtn.className = "feed-tile-close-btn";
      closeBtn.innerHTML = '<i class="ph ph-x"></i>';
      closeBtn.title = "Close";
      closeBtn.addEventListener("click", () => ctx?.requestClose?.());
      header.appendChild(closeBtn);

      root.appendChild(header);

      // Event list
      const list = document.createElement("div");
      list.className = "feed-tile-list";
      list.tabIndex = 0;
      root.appendChild(list);

      // State
      const items = new Map();
      let autoKey = 0;
      const isProgress = topicMeta.type === "progress";

      function handleEvent(envelope) {
        let msg;
        try { msg = JSON.parse(envelope.message); } catch { msg = envelope.message; }

        const key = isProgress && msg.step ? msg.step : `_evt_${autoKey++}`;
        let row = items.get(key);

        if (!row) {
          row = document.createElement("div");
          list.appendChild(row);
          items.set(key, row);
        }

        if (isProgress) {
          renderProgressItem(row, msg);
        } else {
          renderLogItem(row, msg, envelope.timestamp);
        }

        list.scrollTop = list.scrollHeight;
      }

      // Connect SSE
      const url = `/sub/${encodeURIComponent(topic)}?fromSeq=0`;
      es = new EventSource(url);
      es.onmessage = (event) => {
        if (!mounted) return;
        try {
          handleEvent(JSON.parse(event.data));
        } catch { /* ignore malformed */ }
      };
    }

    // ── Handle ──────────────────────────────────────────────────
    return {
      unmount() {
        mounted = false;
        if (es) es.close();
        for (const fn of cleanups) fn();
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
