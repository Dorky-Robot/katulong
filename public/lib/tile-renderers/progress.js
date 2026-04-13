/**
 * Progress Tile Renderer — single-file renderer, no factory layer.
 *
 * Subscribes to a pub/sub topic via EventSource (SSE) and renders a
 * live checklist. Each event with a `step` field updates the matching
 * row in-place (pending → active → done → error). Events without a
 * `step` field are appended as one-off log lines.
 *
 * Props:  { topic: string, title?: string }
 * Events: { step, status, detail?, files?, ts? }  (parsed from topic)
 */

const STATUS = {
  pending: { char: "\u25CB", cls: "status-pending" },   // ○
  active:  { char: "\u25C9", cls: "status-active"  },   // ◉
  done:    { char: "\u25CF", cls: "status-done"    },   // ●
  error:   { char: "\u2715", cls: "status-error"   },   // ✕
};

export const progressRenderer = {
  type: "progress",

  init() {},

  describe(props) {
    return {
      title: props.title || props.topic || "Progress",
      icon: "list-checks",
      persistable: true,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    const items = new Map();   // step → { bulletEl, detailEl, el }
    let eventSource = null;

    // --- DOM ---
    const root = document.createElement("div");
    root.className = "progress-tile-root";

    const header = document.createElement("div");
    header.className = "progress-tile-header";
    header.textContent = props.title || props.topic;
    root.appendChild(header);

    const list = document.createElement("div");
    list.className = "progress-tile-list";
    list.tabIndex = 0;
    root.appendChild(list);
    el.appendChild(root);

    // --- Render helpers ---

    function renderItem(step, data) {
      const s = STATUS[data.status] || STATUS.pending;
      const existing = items.get(step);

      if (existing) {
        existing.bulletEl.textContent = s.char;
        existing.bulletEl.className = `progress-bullet ${s.cls}`;
        if (data.detail != null) existing.detailEl.textContent = data.detail;
        return;
      }

      const itemEl = document.createElement("div");
      itemEl.className = "progress-item";

      const bulletEl = document.createElement("span");
      bulletEl.className = `progress-bullet ${s.cls}`;
      bulletEl.textContent = s.char;

      const textEl = document.createElement("span");
      textEl.className = "progress-step";
      textEl.textContent = step;

      const detailEl = document.createElement("div");
      detailEl.className = "progress-detail";
      if (data.detail != null) detailEl.textContent = data.detail;

      itemEl.appendChild(bulletEl);
      itemEl.appendChild(textEl);
      if (data.detail != null) itemEl.appendChild(detailEl);
      list.appendChild(itemEl);

      items.set(step, { bulletEl, detailEl, el: itemEl });
      list.scrollTop = list.scrollHeight;
    }

    function appendLog(text) {
      const itemEl = document.createElement("div");
      itemEl.className = "progress-item progress-log";
      itemEl.textContent = text;
      list.appendChild(itemEl);
      list.scrollTop = list.scrollHeight;
    }

    // --- SSE ---

    function connect() {
      const url = `/sub/${encodeURIComponent(props.topic)}?fromSeq=0`;
      eventSource = new EventSource(url);

      eventSource.onmessage = (e) => {
        try {
          const envelope = JSON.parse(e.data);
          const msg = typeof envelope.message === "string"
            ? JSON.parse(envelope.message)
            : envelope.message;
          if (msg.step) {
            renderItem(msg.step, msg);
          } else if (typeof msg === "string") {
            appendLog(msg);
          }
        } catch { /* ignore malformed */ }
      };
    }

    connect();

    return {
      unmount() {
        if (eventSource) { eventSource.close(); eventSource = null; }
        el.innerHTML = "";
      },
      focus() { list?.focus(); },
      blur() {},
      resize() {},
      getSessions() { return []; },
      tile: null,
    };
  },
};
