/**
 * Feed Tile Renderer
 *
 * Event streamer that subscribes to a pub/sub topic via SSE and renders
 * events according to topic metadata. The tile is a subscriber — it
 * decides how to display raw domain events. Another subscriber (an
 * orchestrator) could use the same events for choreography.
 *
 * Dual role:
 *   - Generic mode — pick any topic and stream it.
 *   - Claude-aware mode — when `props.awaitingClaude` is set, render a
 *     blank stream and auto-swap to the live `claude/<uuid>` topic the
 *     moment a fresh uuid surfaces (via sessionStore or topic-new event).
 *
 * Lifecycle:
 *   1. Opens blank with an inline topic picker (fetched from /api/topics)
 *   2. User picks a topic → tile starts streaming via SSE
 *   3. Rendering strategy chosen by topic meta.type (closed enumeration —
 *      not an extension point; new strategies require an in-tree PR):
 *      - "progress" — checklist with keyed step updates + status bullets
 *      - default    — chronological event log with timestamps
 *
 * Single-file renderer. `init({ getSessionStore })` is optional — when
 * omitted the awaiting-Claude view falls back to the topic-new broadcast
 * path alone.
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

  // Narrative — blog-like markdown update from the Ollama model.
  if (status === "narrative") {
    const prose = document.createElement("div");
    prose.className = "feed-tile-narrative";
    prose.textContent = msg.step || "";
    row.appendChild(prose);
    return;
  }

  // Completion — Claude's last assistant message from a Stop hook.
  // Shown at full legibility because it's often the only signal a
  // resumed session emits before (or without) an Ollama narrative.
  if (status === "completion") {
    const prose = document.createElement("div");
    prose.className = "feed-tile-completion";
    prose.textContent = msg.step || "";
    row.appendChild(prose);
    return;
  }

  // Summary — session objective line from the model.
  if (status === "summary") {
    const summaryEl = document.createElement("div");
    summaryEl.className = "feed-tile-summary";
    summaryEl.textContent = msg.step || "";
    row.appendChild(summaryEl);
    return;
  }

  // Attention — Claude is waiting for user input.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _sessionStoreGetter = () => null;

export const feedRenderer = {
  type: "feed",

  init({ getSessionStore } = {}) {
    _sessionStoreGetter = typeof getSessionStore === "function"
      ? getSessionStore
      : () => null;
  },

  describe(props) {
    // Awaiting-Claude tiles are transient — a reload without a live click
    // would restore a blank waiter whose baseline is epoch-zero, which
    // would then swap to any lingering claude/<uuid> uuid. Drop them on
    // reload and let the user re-invoke the sparkle.
    const persistable = !props.awaitingClaude;
    return {
      title: props.title || props.topic || "Feed",
      icon: "rss",
      persistable,
      session: null,
      updatesUrl: false,
      renameable: false,
      handlesDnd: false,
    };
  },

  mount(el, { id, props, dispatch, ctx }) {
    let mounted = true;
    let es = null;
    // View-local cleanups: drained whenever we transition between views
    // (picker → awaiting → streaming) so stale window listeners don't
    // accumulate. Each view function calls drainViewCleanups() before
    // registering its own listeners.
    let viewCleanups = [];
    function drainViewCleanups() {
      const fns = viewCleanups;
      viewCleanups = [];
      for (const fn of fns) { try { fn(); } catch { /* ignore */ } }
    }

    const root = document.createElement("div");
    root.className = "feed-tile-root";
    el.appendChild(root);

    // Shared header for awaiting + streaming views — keeps the DOM
    // identical across the transition so the swap has no visual reshuffle.
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

      return header;
    }

    // Route on mount:
    //   - `topic` present → stream it (normal restore path).
    //   - `awaitingClaude: { session, baseline }` → blank stream view that
    //     subscribes to the session store and auto-swaps when the Claude
    //     uuid for `session` advances past `baseline`.
    //   - otherwise → topic picker.
    try {
      if (props.topic) {
        startStreaming(props.topic, props.meta || {});
      } else if (props.awaitingClaude?.session) {
        startAwaitingClaude(props.awaitingClaude.session, props.awaitingClaude.baseline || null);
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
      viewCleanups.push(() => window.removeEventListener("katulong:topic-new", onTopicNew));

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

    // ── Awaiting Claude view ────────────────────────────────────
    // Shown when the user clicks the Claude sparkle before the
    // SessionStart hook has reported a fresh uuid. Renders a blank
    // stream (header + empty list) and waits for the sessionStore
    // to surface a uuid that is newer than the click-time baseline,
    // then swaps to the real streaming view with no UI reshuffle.
    function startAwaitingClaude(sessionName, baseline) {
      if (es) { es.close(); es = null; }
      drainViewCleanups();
      root.innerHTML = "";

      root.appendChild(buildStreamHeader("Claude"));

      const list = document.createElement("div");
      list.className = "feed-tile-list";
      list.tabIndex = 0;
      root.appendChild(list);

      const seenUuid = baseline?.uuid || null;
      const seenStartedAt = baseline?.startedAt || 0;

      // Policy mirror: see `applyClaudeMetaFromHook` in
      // lib/routes/app-routes.js — SessionStart bumps `startedAt`, so a
      // newer uuid OR a later `startedAt` signals a new Claude session
      // worth swapping to.
      function isNewerSession(m) {
        if (!m?.uuid) return false;
        if (m.uuid !== seenUuid) return true;
        return (m.startedAt || 0) > seenStartedAt;
      }

      let swapped = false;
      function swapToTopic(uuid) {
        if (swapped) return;
        swapped = true;
        const topic = `claude/${uuid}`;
        const meta = { type: "progress" };
        if (dispatch) {
          dispatch({
            type: "ui/UPDATE_PROPS",
            id,
            patch: {
              topic, title: topic, meta,
              awaitingClaude: null,
            },
          });
        }
        startStreaming(topic, meta);
      }

      // Topic-new listener: broadcast path. The pub/sub bridge publishes
      // a `katulong:topic-new` CustomEvent whenever a topic is created on
      // the server — this fires even when session.meta.claude.uuid never
      // surfaces (e.g. hooks were installed late, or the session store
      // isn't the authoritative source). Matches any fresh `claude/<uuid>`.
      function onTopicNew(e) {
        if (!mounted || swapped) return;
        const topic = e?.detail?.topic || "";
        if (!topic.startsWith("claude/")) return;
        const uuid = topic.slice("claude/".length);
        // Defense-in-depth: the server already gates /sub/ topics via an
        // allowlist regex, but matching here too keeps client-side pivots
        // safe regardless of who dispatched the CustomEvent.
        if (!UUID_RE.test(uuid) || uuid === seenUuid) return;
        swapToTopic(uuid);
      }
      window.addEventListener("katulong:topic-new", onTopicNew);
      viewCleanups.push(() => window.removeEventListener("katulong:topic-new", onTopicNew));

      const store = _sessionStoreGetter();
      if (!store) return; // No store wired — topic-new listener still active.

      function readClaudeMeta() {
        const { sessions } = store.getState();
        const s = (sessions || []).find((x) => x.name === sessionName);
        return s?.meta?.claude || null;
      }

      // Check once synchronously in case the uuid landed between the
      // click and mount.
      const immediate = readClaudeMeta();
      if (isNewerSession(immediate)) { swapToTopic(immediate.uuid); return; }

      const unsubscribe = store.subscribe(() => {
        if (!mounted || swapped) return;
        const m = readClaudeMeta();
        if (isNewerSession(m)) swapToTopic(m.uuid);
      });
      viewCleanups.push(unsubscribe);
    }

    // ── Streaming view ──────────────────────────────────────────
    function startStreaming(topic, meta) {
      if (es) { es.close(); es = null; }
      drainViewCleanups();
      root.innerHTML = "";
      const topicMeta = meta || {};

      root.appendChild(buildStreamHeader(topic));

      const list = document.createElement("div");
      list.className = "feed-tile-list";
      list.tabIndex = 0;
      root.appendChild(list);

      const items = new Map();
      let autoKey = 0;
      const isProgress = topicMeta.type === "progress";

      // Narrative-first rendering: narrative/summary/attention events are
      // always visible. Tool-use progress events (active, done, pending,
      // text, etc.) collapse into expandable <details> groups between
      // narrative blocks so the feed reads like a blog, not a log.
      const PROMINENT = new Set(["narrative", "summary", "attention", "completion"]);
      let currentDetails = null; // the open <details> group, if any
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
        // Caller increments detailCount + calls updateDetailsSummary for
        // the first item, which sets the visible label.
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
          // Close the current details group — next non-prominent events
          // will start a fresh group after this prominent item.
          currentDetails = null;

          let row = items.get(key);
          if (!row) {
            row = document.createElement("div");
            list.appendChild(row);
            items.set(key, row);
          }
          renderProgressItem(row, msg);
        } else if (isProgress) {
          // Non-prominent: tuck into a collapsible group
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
