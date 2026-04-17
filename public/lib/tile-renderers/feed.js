/**
 * Feed Tile Renderer
 *
 * Subscribes to a pub/sub topic via SSE and renders events according to
 * topic metadata. Pure subscriber — no knowledge of who produces events.
 *
 * Routing:
 *   - `claude/<uuid>` topics stream via `/api/claude/stream/:uuid`. That
 *     endpoint acquires a per-UUID narrator refcount for the lifetime of
 *     the connection, so narration only runs while the tile is open.
 *     Opt-in (POST /api/claude/watch) happens elsewhere — typically the
 *     sparkle-click handler in app.js.
 *   - Any other topic streams via `/sub/<topic>`, the generic broker SSE.
 *
 * Lifecycle:
 *   1. Mount with `props.topic` → stream immediately.
 *   2. Mount without → inline topic picker (from /api/topics).
 *   3. Rendering strategy chosen by `props.meta.type`:
 *        "progress" — prominent narrative/summary/attention/completion
 *                     rows plus collapsible groups of lower-signal steps.
 *        default    — chronological event log with timestamps.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rotating gerunds for the "working" card shown between a completion event
// and the Ollama-generated narrative. Goofy on purpose — a frozen-looking
// feed is a worse UX than a slightly-silly one.
const WORKING_PHRASES = [
  "whatcha-diggling…",
  "whatcumacalling…",
  "thingamabobbing…",
  "jibber-jabbering…",
  "noodle-noodling…",
  "doodad-dabbling…",
  "widget-wiggling…",
  "dingus-doodling…",
  "whatnot-whirring…",
  "thinky-thinking…",
  "brain-wriggling…",
  "gizmo-jiggling…",
  "snuffling-about…",
  "neuron-noodling…",
  "bamboozling-a-thought…",
  "hmm-hmming…",
  "cog-whirring…",
  "puzzle-piecing…",
  "head-scratching…",
  "marinating-a-muse…",
  "percolating-prose…",
  "mulling-mulishly…",
  "flummoxing…",
  "scritch-scratching…",
  "tinker-tonking…",
  "wrassling-a-whatsit…",
  "squiggle-thinking…",
  "brain-gerbiling…",
  "doohickey-ducking…",
  "woo-wooing-a-notion…",
];
const WORKING_ROTATE_MS = 2000;
const WORKING_TIMEOUT_MS = 90000;

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

// Claude's own reply — both Stop-hook "completion" events and
// question-form "attention" events echo the assistant text the user
// already saw in the terminal. Render the same way in both cases: a
// collapsible <details> whose summary shows a word count and a small hint
// that input is required for the question variant.
function isClaudeReply(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.status === "completion") return true;
  // PreToolUse attention cards carry a non-null `tool` — those are tool
  // approval prompts (actionable), NOT echoes. Keep those prominent.
  if (msg.status === "attention" && !msg.tool) return true;
  return false;
}

function renderProgressItem(row, msg) {
  row.innerHTML = "";
  const status = msg.status || "info";
  const reply = isClaudeReply(msg);
  row.className = reply
    ? "feed-tile-item feed-status-reply"
    : `feed-tile-item feed-status-${status}`;

  if (status === "text") {
    const text = document.createElement("span");
    text.className = "feed-tile-step feed-tile-assistant-text";
    text.textContent = msg.step || "";
    row.appendChild(text);
    return;
  }

  if (status === "narrative") {
    const prose = document.createElement("div");
    prose.className = "feed-tile-narrative";
    prose.textContent = msg.step || "";
    row.appendChild(prose);
    return;
  }

  if (reply) {
    const text = msg.step || "";
    const words = text ? text.trim().split(/\s+/).length : 0;
    const awaiting = msg.status === "attention";
    const summary = document.createElement("summary");
    summary.className = "feed-tile-reply-summary";
    const label = words
      ? `Claude's reply (${words} word${words === 1 ? "" : "s"})`
      : "Claude's reply";
    summary.textContent = awaiting ? `${label} \u00b7 waiting for you` : label;
    row.appendChild(summary);
    const prose = document.createElement("div");
    prose.className = "feed-tile-reply-body";
    prose.textContent = text;
    row.appendChild(prose);
    return;
  }

  if (status === "summary") {
    const summaryEl = document.createElement("div");
    summaryEl.className = "feed-tile-summary";
    summaryEl.textContent = msg.step || "";
    row.appendChild(summaryEl);
    return;
  }

  if (status === "attention") {
    const attn = document.createElement("div");
    attn.className = "feed-tile-attention";
    attn.textContent = msg.step || "Waiting for input\u2026";
    row.appendChild(attn);
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

      // "Working" card lifecycle: after a completion event we show a card
      // with a pulsing dot and a rotating goofy gerund so the user knows
      // Ollama is still chewing. Hidden when a narrative/summary/attention
      // event arrives or after WORKING_TIMEOUT_MS (covers disabled/failed
      // narrator so the card doesn't stick forever). Appended to `list` at
      // the bottom — a new completion moves it back to the bottom.
      let workingCard = null;
      let workingRotateTimer = null;
      let workingHideTimer = null;
      function showWorkingCard() {
        if (!workingCard) {
          workingCard = document.createElement("div");
          workingCard.className = "feed-tile-working-card";
          const dot = document.createElement("span");
          dot.className = "feed-tile-working-dot";
          workingCard.appendChild(dot);
          const phrase = document.createElement("span");
          phrase.className = "feed-tile-working-phrase";
          phrase.textContent = WORKING_PHRASES[Math.floor(Math.random() * WORKING_PHRASES.length)];
          workingCard.appendChild(phrase);
        } else {
          workingCard.remove();
        }
        list.appendChild(workingCard);
        if (workingRotateTimer) clearInterval(workingRotateTimer);
        workingRotateTimer = setInterval(() => {
          const phrase = workingCard?.querySelector(".feed-tile-working-phrase");
          if (phrase) phrase.textContent = WORKING_PHRASES[Math.floor(Math.random() * WORKING_PHRASES.length)];
        }, WORKING_ROTATE_MS);
        if (workingHideTimer) clearTimeout(workingHideTimer);
        workingHideTimer = setTimeout(hideWorkingCard, WORKING_TIMEOUT_MS);
      }
      function hideWorkingCard() {
        if (workingRotateTimer) { clearInterval(workingRotateTimer); workingRotateTimer = null; }
        if (workingHideTimer) { clearTimeout(workingHideTimer); workingHideTimer = null; }
        if (workingCard) { workingCard.remove(); workingCard = null; }
      }
      viewCleanups.push(hideWorkingCard);

      const items = new Map();
      let autoKey = 0;
      const isProgress = topicMeta.type === "progress";

      // Narrative-first rendering: narrative/summary/attention/completion
      // are always visible. Tool-use progress events collapse into
      // expandable <details> groups between narrative blocks.
      const PROMINENT = new Set(["narrative", "summary", "attention", "completion"]);
      let currentDetails = null;
      let detailCount = 0;

      function ensureDetailsGroup() {
        if (currentDetails) return currentDetails.querySelector(".feed-tile-details-body");
        currentDetails = document.createElement("details");
        currentDetails.className = "feed-tile-details-group";
        const summary = document.createElement("summary");
        summary.className = "feed-tile-details-summary";
        currentDetails.appendChild(summary);
        const body = document.createElement("div");
        body.className = "feed-tile-details-body";
        currentDetails.appendChild(body);
        list.appendChild(currentDetails);
        detailCount = 0;
        return body;
      }

      function updateDetailsSummary() {
        if (!currentDetails) return;
        const summary = currentDetails.querySelector("summary");
        summary.textContent = `${detailCount} step${detailCount === 1 ? "" : "s"}`;
      }

      function handleEvent(envelope) {
        let msg;
        try { msg = JSON.parse(envelope.message); } catch { msg = envelope.message; }

        const status = (typeof msg === "object" && msg.status) || "";
        const key = isProgress && msg.step ? msg.step : `_evt_${autoKey++}`;

        if (isProgress && PROMINENT.has(status)) {
          currentDetails = null;

          const replyShape = isClaudeReply(typeof msg === "object" ? msg : {});
          let row = items.get(key);
          const desiredTag = replyShape ? "DETAILS" : "DIV";
          if (row && row.tagName !== desiredTag) {
            row.remove();
            items.delete(key);
            row = null;
          }
          if (!row) {
            row = document.createElement(replyShape ? "details" : "div");
            list.appendChild(row);
            items.set(key, row);
          }
          renderProgressItem(row, msg);

          // Reply events (completion or question-form attention) mean the
          // model just spoke — kick the "working" card until the Ollama
          // narrative lands. Narrative / summary / tool-approval attention
          // supersede it, so hide in those cases.
          if (replyShape) {
            showWorkingCard();
          } else if (status === "narrative" || status === "summary" || status === "attention") {
            hideWorkingCard();
          }
          // If the working card is present, keep it at the bottom.
          if (workingCard && workingCard.parentNode === list) list.appendChild(workingCard);
        } else if (isProgress) {
          const body = ensureDetailsGroup();
          let row = items.get(key);
          if (!row) {
            row = document.createElement("div");
            body.appendChild(row);
            items.set(key, row);
            detailCount++;
            updateDetailsSummary();
          }
          renderProgressItem(row, msg);
        } else {
          let row = items.get(key);
          if (!row) {
            row = document.createElement("div");
            list.appendChild(row);
            items.set(key, row);
          }
          renderLogItem(row, msg, envelope.timestamp);
        }

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
        ? "Waiting for Claude narration\u2026 if this stays blank, re-open the feed from the sparkle button."
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
          ? "Couldn't open Claude narration. Click the sparkle button to re-subscribe."
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
