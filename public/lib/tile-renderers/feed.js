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
      persistable: !!props.topic, // only persist once a topic is chosen
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    let mounted = true;
    let es = null;

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
      root.innerHTML = "";

      const picker = document.createElement("div");
      picker.className = "feed-tile-picker";

      const title = document.createElement("div");
      title.className = "feed-tile-picker-title";
      title.textContent = "Subscribe to a topic";
      picker.appendChild(title);

      const listArea = document.createElement("div");
      listArea.className = "feed-tile-picker-list";
      listArea.textContent = "Loading topics\u2026";
      picker.appendChild(listArea);

      root.appendChild(picker);

      // Fetch topics and populate
      fetch("/api/topics", { credentials: "same-origin", redirect: "error" })
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
        .then(topics => {
          if (!mounted) return;
          listArea.textContent = "";

          if (topics.length > 0) {
            for (const t of topics) {
              const item = document.createElement("button");
              item.className = "feed-tile-picker-item";

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
          } else {
            const empty = document.createElement("div");
            empty.className = "feed-tile-picker-empty";
            empty.textContent = "No topics yet. Publish events to create one.";
            listArea.appendChild(empty);
          }

          const refreshBtn = document.createElement("button");
          refreshBtn.className = "feed-tile-picker-refresh";
          refreshBtn.textContent = "Refresh";
          refreshBtn.addEventListener("click", () => { if (mounted) showTopicPicker(); });
          listArea.appendChild(refreshBtn);
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

      const headerTitle = document.createElement("span");
      headerTitle.className = "feed-tile-header-title";
      headerTitle.textContent = topic;
      header.appendChild(headerTitle);

      if (topicMeta.type) {
        const badge = document.createElement("span");
        badge.className = "feed-tile-badge";
        badge.textContent = topicMeta.type;
        header.appendChild(badge);
      }

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
