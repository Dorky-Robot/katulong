/**
 * Dispatch Panel
 *
 * Minimal feature queue with inline #project mentions.
 * Type naturally — "#ka" autocompletes to "#katulong".
 * Projects are parsed from the text, not picked separately.
 *
 * Batch refine: select raw cards via checkbox, then "Refine N selected"
 * or "Refine all raw". Refining happens headlessly in the background.
 * In-flight progress is shown in a single global activity panel at the
 * top of the sidebar — not per-card — because a batch refine can span
 * multiple tickets and projects, and the activity belongs to the user's
 * workflow rather than to any one ticket.
 */

import { api } from '/lib/api-client.js';

// ── Helpers ──────────────────────────────────────────────────────────

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Extract #project tags from text.
 * Returns { text: cleaned text, projects: ['katulong', 'yelo'] }
 */
function parseHashtags(text) {
  const tags = [];
  const cleaned = text.replace(/@([a-zA-Z0-9._-]+)/g, (_, tag) => {
    tags.push(tag);
    return '';
  }).replace(/\s+/g, ' ').trim();
  return { text: cleaned, projects: tags };
}

// ── Panel ────────────────────────────────────────────────────────────

export function createDispatchPanel(container) {
  let destroyed = false;
  let eventSource = null;
  const features = new Map();
  const selected = new Set(); // selected raw feature IDs for batch refine
  let projectCache = null;

  // Active refine sessions keyed by sessionTag. Each entry:
  //   { sessionTag, count, featureIds, startedAt, bullets: [{text, ts}], status, hideTimer? }
  // The panel aggregates bullets from all in-flight sessions into one rolling
  // list, because a single refine can span multiple tickets/projects and the
  // user wants to feel it as one global activity, not per-card.
  const refineSessions = new Map();
  const SESSION_HIDE_DELAY_MS = 1800;

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.textContent = PANEL_CSS;
  document.head.appendChild(styleEl);

  const panel = el('div', { className: 'dp' });
  panel.addEventListener('keydown', (e) => e.stopPropagation());
  panel.addEventListener('keypress', (e) => e.stopPropagation());
  panel.addEventListener('keyup', (e) => e.stopPropagation());

  // ── Composer ─────────────────────────────────────────────────────

  const composer = el('div', { className: 'dp-composer' });
  const textarea = el('textarea', {
    className: 'dp-textarea',
    placeholder: 'What needs to happen? Use @project to scope\u2026',
    rows: '2',
  });
  const sendRow = el('div', { className: 'dp-send-row' });
  const hint = el('span', { className: 'dp-hint' });
  const sendBtn = el('button', { className: 'dp-send' }, [
    el('i', { className: 'ph ph-arrow-up' }),
  ]);
  sendRow.appendChild(hint);
  sendRow.appendChild(sendBtn);
  composer.appendChild(textarea);
  composer.appendChild(sendRow);

  // Autocomplete dropdown
  const dropdown = el('div', { className: 'dp-autocomplete dp-hidden' });
  composer.appendChild(dropdown);

  panel.appendChild(composer);

  // ── Action bar (shown when raw cards are selected) ───────────────

  const actionBar = el('div', { className: 'dp-action-bar dp-hidden' });
  const refineSelectedBtn = el('button', { className: 'dp-batch-btn', textContent: 'Refine 0 selected' });
  const refineAllBtn = el('button', { className: 'dp-batch-btn dp-batch-all', textContent: 'Refine all raw' });

  refineSelectedBtn.addEventListener('click', () => {
    if (selected.size === 0) return;
    triggerBatchRefine([...selected]);
  });
  refineAllBtn.addEventListener('click', () => {
    triggerBatchRefine(null); // null = all raw
  });

  actionBar.appendChild(refineSelectedBtn);
  actionBar.appendChild(refineAllBtn);
  panel.appendChild(actionBar);

  // ── Refine activity panel ────────────────────────────────────────
  // Global, sidebar-level "refining" status. Shows while any refine session
  // is in flight, aggregating bullets across all sessions. Hidden otherwise.
  const activityPanel = el('div', { className: 'dp-activity dp-hidden' });
  const activityHeader = el('div', { className: 'dp-activity-header' });
  const activityDot = el('span', { className: 'dp-activity-dot' });
  const activityLabel = el('span', { className: 'dp-activity-label', textContent: 'Refining\u2026' });
  activityHeader.appendChild(activityDot);
  activityHeader.appendChild(activityLabel);
  const activityList = el('div', { className: 'dp-activity-list' });
  activityPanel.appendChild(activityHeader);
  activityPanel.appendChild(activityList);
  panel.appendChild(activityPanel);

  function renderActivity() {
    if (destroyed) return;

    const sessions = [...refineSessions.values()];
    const running = sessions.filter((s) => s.status === 'running');
    // If nothing active and nothing finishing, hide.
    if (sessions.length === 0) {
      activityPanel.classList.add('dp-hidden');
      activityPanel.classList.remove('dp-activity-done');
      return;
    }

    // Header text — total tickets being refined across all running sessions.
    // When all sessions have finished (only cooldown remaining), show "Done".
    if (running.length === 0) {
      activityLabel.textContent = 'Refine complete';
      activityPanel.classList.add('dp-activity-done');
    } else {
      const total = running.reduce((n, s) => n + (s.count || 0), 0);
      activityLabel.textContent =
        `Refining ${total} idea${total === 1 ? '' : 's'}\u2026`;
      activityPanel.classList.remove('dp-activity-done');
    }

    // Aggregate bullets from every session in arrival order. Sessions cap
    // their own bullets server-side at 200, so this list stays bounded.
    const all = [];
    for (const s of sessions) {
      for (const b of s.bullets) all.push(b);
    }
    all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    // Incremental DOM update: reconcile by key so existing bullets don't get
    // re-animated on every render (would trigger the fade-in every time a new
    // bullet arrives). Only freshly-added bullets animate in.
    const existingKeys = new Set();
    for (const node of activityList.children) {
      existingKeys.add(node.dataset.key || '');
    }
    const wantedKeys = new Set(all.map((b) => b.ts + '|' + b.text));

    // Remove nodes whose keys are no longer wanted.
    for (const node of [...activityList.children]) {
      if (!wantedKeys.has(node.dataset.key)) node.remove();
    }
    // Append new bullets at the bottom in order.
    for (const b of all) {
      const key = b.ts + '|' + b.text;
      if (existingKeys.has(key)) continue;
      const node = el('div', { className: 'dp-activity-bullet', textContent: b.text });
      node.dataset.key = key;
      activityList.appendChild(node);
    }

    // Scroll newest into view. CSS limits the list to VISIBLE_BULLETS rows
    // with overflow-y: auto, so this produces a smooth scroll feel as new
    // bullets arrive and older ones slide up past the top edge.
    activityList.scrollTop = activityList.scrollHeight;

    activityPanel.classList.remove('dp-hidden');
  }

  function upsertSession(session) {
    const existing = refineSessions.get(session.sessionTag);
    if (existing && existing.hideTimer) clearTimeout(existing.hideTimer);
    refineSessions.set(session.sessionTag, {
      sessionTag: session.sessionTag,
      count: session.count || (session.featureIds || []).length || 1,
      featureIds: session.featureIds || [],
      startedAt: session.startedAt || new Date().toISOString(),
      bullets: Array.isArray(session.bullets) ? [...session.bullets] : [],
      status: session.status || 'running',
    });
    renderActivity();
  }

  function appendBulletToSession(sessionTag, bullet) {
    const s = refineSessions.get(sessionTag);
    if (!s) return;
    s.bullets.push(bullet);
    renderActivity();
  }

  function markSessionFinished(sessionTag, outcome) {
    const s = refineSessions.get(sessionTag);
    if (!s) return;
    s.status = outcome; // "completed" | "failed"
    renderActivity();
    // Leave the panel up briefly so the user registers "done", then fade.
    if (s.hideTimer) clearTimeout(s.hideTimer);
    s.hideTimer = setTimeout(() => {
      refineSessions.delete(sessionTag);
      renderActivity();
    }, SESSION_HIDE_DELAY_MS);
  }

  function updateActionBar() {
    const rawCount = [...features.values()].filter((f) => f.status === 'raw').length;
    // Prune selected set — remove IDs that are no longer raw
    for (const id of selected) {
      const f = features.get(id);
      if (!f || f.status !== 'raw') selected.delete(id);
    }
    if (selected.size > 0 || rawCount > 0) {
      actionBar.classList.remove('dp-hidden');
      refineSelectedBtn.textContent = `Refine ${selected.size} selected`;
      refineSelectedBtn.disabled = selected.size === 0;
      refineAllBtn.textContent = `Refine all raw (${rawCount})`;
      refineAllBtn.disabled = rawCount === 0;
    } else {
      actionBar.classList.add('dp-hidden');
    }
  }

  async function triggerBatchRefine(ids) {
    try {
      const body = ids ? { featureIds: ids } : { all: true };
      await api.post('/api/dispatch/refine', body);
      selected.clear();
      await refreshFeatures();
    } catch (err) {
      console.error('[Dispatch] Batch refine failed:', err);
    }
  }

  // ── Project autocomplete ─────────────────────────────────────────

  // Projects are loaded alongside features (same endpoint, same auth)
  function setProjects(list) {
    if (Array.isArray(list) && list.length > 0) projectCache = list;
  }

  // Also try loading from the standalone endpoint as fallback
  async function ensureProjects() {
    if (projectCache && projectCache.length > 0) return;
    try {
      const res = await fetch('/api/dispatch/projects');
      if (res.ok) { const data = await res.json(); setProjects(data); }
    } catch {}
  }

  let acIndex = -1;

  function showAutocomplete(query) {
    if (!projectCache || query.length === 0) {
      dropdown.classList.add('dp-hidden');
      return;
    }
    const q = query.toLowerCase();
    const matches = projectCache
      .filter((p) => (p.slug || p.name || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const as = (a.slug || a.name || '').toLowerCase();
        const bs = (b.slug || b.name || '').toLowerCase();
        const aStarts = as.startsWith(q);
        const bStarts = bs.startsWith(q);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return as.length - bs.length; // shorter = more relevant
      })
      .slice(0, 6);

    if (matches.length === 0) {
      dropdown.classList.add('dp-hidden');
      return;
    }

    dropdown.textContent = '';
    acIndex = -1;
    for (const p of matches) {
      const slug = p.slug || p.name;
      const item = el('div', { className: 'dp-ac-item' });
      item.appendChild(el('span', { className: 'dp-ac-slug', textContent: slug }));
      if (p.path) {
        item.appendChild(el('span', { className: 'dp-ac-path', textContent: p.path.replace(/^~\/Projects\/dorky_robot\//, '') }));
      }
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        completeTag(slug);
      });
      dropdown.appendChild(item);
    }
    dropdown.classList.remove('dp-hidden');
  }

  function completeTag(slug) {
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    // Find the # that started this tag
    let hashPos = val.lastIndexOf('@', cursor - 1);
    if (hashPos < 0) hashPos = cursor;
    const before = val.slice(0, hashPos);
    const after = val.slice(cursor);
    textarea.value = `${before}@${slug} ${after}`;
    textarea.selectionStart = textarea.selectionEnd = hashPos + slug.length + 2;
    dropdown.classList.add('dp-hidden');
    textarea.focus();
    updateHint();
  }

  function getTagQuery() {
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    // Walk back from cursor to find a # not preceded by a word char
    let i = cursor - 1;
    while (i >= 0 && /[a-zA-Z0-9._-]/.test(val[i])) i--;
    if (i >= 0 && val[i] === '@' && (i === 0 || /\s/.test(val[i - 1]))) {
      return val.slice(i + 1, cursor);
    }
    return null;
  }

  textarea.addEventListener('input', async () => {
    const query = getTagQuery();
    if (query !== null) {
      if (!projectCache || projectCache.length === 0) await ensureProjects();
      showAutocomplete(query);
    } else {
      dropdown.classList.add('dp-hidden');
    }
    updateHint();
  });

  textarea.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.dp-ac-item');
    const dropdownVisible = !dropdown.classList.contains('dp-hidden') && items.length > 0;

    if (dropdownVisible) {
      if (e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault();
        // Tab/Down: cycle forward through matches
        acIndex = (acIndex + 1) % items.length;
        items.forEach((it, i) => it.classList.toggle('dp-ac-active', i === acIndex));
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acIndex = (acIndex - 1 + items.length) % items.length;
        items.forEach((it, i) => it.classList.toggle('dp-ac-active', i === acIndex));
        return;
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (acIndex >= 0) {
          const slug = items[acIndex]?.querySelector('.dp-ac-slug')?.textContent;
          if (slug) completeTag(slug);
        }
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dropdown.classList.add('dp-hidden');
        return;
      }
    }

    // Prevent Tab from leaving the textarea when in a @ context
    if (e.key === 'Tab' && getTagQuery() !== null) {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  textarea.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('dp-hidden'), 150);
  });

  function updateHint() {
    const { projects } = parseHashtags(textarea.value);
    if (projects.length > 0) {
      hint.textContent = projects.map((p) => `@${p}`).join(' ');
    } else {
      hint.textContent = '';
    }
  }

  // ── Submit ───────────────────────────────────────────────────────

  async function submit() {
    const raw = textarea.value.trim();
    if (!raw) return;
    const { projects } = parseHashtags(raw);
    textarea.value = '';
    textarea.style.height = '';
    hint.textContent = '';
    try {
      const body = { raw };
      if (projects.length > 0) body.projects = projects;
      await api.post('/api/dispatch/features', body);
      await refreshFeatures();
    } catch (err) {
      console.error('[Dispatch] Submit failed:', err);
      textarea.value = raw;
    }
    textarea.focus();
  }

  sendBtn.addEventListener('click', submit);

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = '';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  });

  // ── Feature list ─────────────────────────────────────────────────

  const list = el('div', { className: 'dp-list' });
  panel.appendChild(list);

  async function refreshFeatures() {
    try {
      const data = await api.get('/api/dispatch/features');
      // Response is { features: [...], projects: [...] }
      const items = data.features || data;
      features.clear();
      for (const f of (Array.isArray(items) ? items : [])) features.set(f.id, f);
      if (data.projects) setProjects(data.projects);
      render();
    } catch (err) {
      console.error('[Dispatch] Refresh failed:', err);
    }
  }

  function render() {
    if (destroyed) return;
    list.textContent = '';

    const items = [...features.values()].sort((a, b) =>
      new Date(b.created) - new Date(a.created)
    );

    if (items.length === 0) {
      list.appendChild(el('div', { className: 'dp-empty', textContent: 'No ideas yet' }));
    } else {
      for (const f of items) {
        list.appendChild(createCard(f));
      }
    }

    updateActionBar();
  }

  function createCard(f) {
    const card = el('div', { className: `dp-card dp-status-${f.status}` });

    // Checkbox for raw features (batch selection)
    if (f.status === 'raw') {
      const checkbox = el('input', { type: 'checkbox', className: 'dp-checkbox' });
      checkbox.checked = selected.has(f.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(f.id);
        else selected.delete(f.id);
        updateActionBar();
      });
      card.appendChild(checkbox);
    }

    // Main text — render @tags as styled spans
    const textEl = el('div', { className: 'dp-text' });
    const bodyText = f.body || '';
    // For grouped/refining features, show only the first line (the raw idea)
    const displayText = (f.status === 'grouped' || f.status === 'refining')
      ? bodyText.split('\n')[0]
      : bodyText;
    const parts = displayText.split(/(@[a-zA-Z0-9._-]+)/g);
    for (const part of parts) {
      if (part.startsWith('@')) {
        textEl.appendChild(el('span', { className: 'dp-tag', textContent: part }));
      } else if (part.trim()) {
        textEl.appendChild(document.createTextNode(part));
      }
    }
    card.appendChild(textEl);

    // Refined title
    if (f.refined?.title) {
      const titleEl = el('div', { className: 'dp-refined-title', textContent: f.refined.title });
      card.insertBefore(titleEl, card.firstChild);
    }

    // Progress bullets for grouped/refining cards now live in the global
    // activity panel above the list — the same bullets used to appear on
    // every card in the batch, which felt redundant and tied the activity
    // to a single ticket.

    // Meta line — status + time + actions
    const meta = el('div', { className: 'dp-meta' });
    const statusLabel = f.status === 'grouped' ? 'refining' : f.status;
    meta.appendChild(el('span', { className: `dp-status dp-s-${f.status}`, textContent: statusLabel }));
    meta.appendChild(el('span', { className: 'dp-time', textContent: timeAgo(f.created) }));

    // Spacer pushes actions right
    meta.appendChild(el('span', { className: 'dp-spacer' }));

    // Actions based on status
    if (f.status === 'raw') {
      meta.appendChild(actionBtn('Refine', async () => {
        try { await api.post(`/api/dispatch/refine/${encodeURIComponent(f.id)}`); await refreshFeatures(); }
        catch (err) { console.error('[Dispatch] Refine failed:', err); }
      }));
    }
    if (f.status === 'refined') {
      meta.appendChild(actionBtn('Start', async () => {
        try { await api.post(`/api/dispatch/start/${encodeURIComponent(f.id)}`); await refreshFeatures(); }
        catch (err) { console.error('[Dispatch] Start failed:', err); }
      }, 'dp-act-start'));
    }
    // No "Open" button for grouped/refining cards — refine is headless
    if (f.status !== 'grouped' && f.status !== 'refining') {
      meta.appendChild(actionBtn('\u00d7', async () => {
        try { await api.delete(`/api/dispatch/features/${encodeURIComponent(f.id)}`); await refreshFeatures(); }
        catch (err) { console.error('[Dispatch] Dismiss failed:', err); }
      }, 'dp-act-dismiss'));
    }

    card.appendChild(meta);
    return card;
  }

  function actionBtn(label, onclick, cls = '') {
    const btn = el('button', {
      className: `dp-action ${cls}`.trim(),
      textContent: label,
      onClick: onclick,
    });
    return btn;
  }

  // ── SSE ──────────────────────────────────────────────────────────

  function connectSSE() {
    if (destroyed) return;
    eventSource = new EventSource('/api/dispatch/stream');
    eventSource.addEventListener('snapshot', (e) => {
      try {
        const data = JSON.parse(e.data);
        features.clear();
        if (Array.isArray(data.features)) {
          for (const f of data.features) features.set(f.id, f);
        }
        render();
        // Rehydrate in-flight refine sessions so the activity panel shows
        // up immediately on reconnect without waiting for the next event.
        if (Array.isArray(data.refines)) {
          refineSessions.clear();
          for (const s of data.refines) upsertSession(s);
        }
      } catch {}
    });
    for (const evt of ['feature-added', 'feature-updated']) {
      eventSource.addEventListener(evt, (e) => {
        try {
          const data = JSON.parse(e.data);
          const f = data.feature || data;
          if (f?.id) { features.set(f.id, { ...features.get(f.id), ...f }); render(); }
        } catch {}
      });
    }
    eventSource.addEventListener('feature-deleted', (e) => {
      try { features.delete(JSON.parse(e.data).id); render(); } catch {}
    });

    // --- Refine activity (global sidebar panel) ---
    eventSource.addEventListener('refine-started', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.session) upsertSession(data.session);
      } catch {}
    });
    eventSource.addEventListener('refine-progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.sessionTag && data.bullet) appendBulletToSession(data.sessionTag, data.bullet);
      } catch {}
    });
    eventSource.addEventListener('refine-completed', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.sessionTag) markSessionFinished(data.sessionTag, 'completed');
      } catch {}
    });
    eventSource.addEventListener('refine-failed', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.sessionTag) markSessionFinished(data.sessionTag, 'failed');
      } catch {}
    });

    eventSource.onerror = () => {};
  }

  connectSSE();
  refreshFeatures();

  container.appendChild(panel);

  function destroy() {
    destroyed = true;
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (styleEl.parentNode) styleEl.remove();
    if (panel.parentNode) panel.remove();
  }

  return { destroy };
}

// ── CSS ──────────────────────────────────────────────────────────────

const PANEL_CSS = `
.dp {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
}

/* Composer */
.dp-composer {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  position: relative;
}
.dp-textarea {
  width: 100%;
  min-height: 36px;
  max-height: 120px;
  padding: 8px 10px;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  resize: none;
  outline: none;
  box-sizing: border-box;
}
.dp-textarea:focus { border-color: var(--accent-active); }
.dp-textarea::placeholder { color: var(--text-dim); }
.dp-send-row {
  display: flex;
  align-items: center;
  margin-top: 6px;
  gap: 6px;
}
.dp-hint {
  flex: 1;
  font-size: 11px;
  color: var(--accent-active);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dp-send {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--accent-active);
  color: var(--bg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  transition: opacity 0.1s;
}
.dp-send:hover { opacity: 0.85; }

/* Autocomplete */
.dp-autocomplete {
  position: absolute;
  left: 12px;
  right: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  z-index: 10;
  max-height: 180px;
  overflow-y: auto;
}
.dp-hidden { display: none !important; }
.dp-ac-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.08s;
}
.dp-ac-item:hover, .dp-ac-item.dp-ac-active {
  background: var(--accent);
}
.dp-ac-slug {
  color: var(--accent-active);
  font-weight: 500;
}
.dp-ac-slug::before { content: '@'; }
.dp-ac-path {
  color: var(--text-dim);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Action bar */
.dp-action-bar {
  display: flex;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
}
.dp-batch-btn {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.1s;
}
.dp-batch-btn:hover:not(:disabled) { border-color: var(--accent-active); color: var(--accent-active); }
.dp-batch-btn:disabled { opacity: 0.4; cursor: default; }
.dp-batch-all { margin-left: auto; }

/* Feature list */
.dp-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.dp-empty {
  text-align: center;
  color: var(--text-dim);
  padding: 32px 12px;
  font-size: 12px;
}

/* Cards */
.dp-card {
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  transition: background 0.1s;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dp-card:hover { background: color-mix(in srgb, var(--bg-surface) 50%, transparent); }
.dp-checkbox {
  align-self: flex-start;
  margin: 2px 0;
  accent-color: var(--accent-active);
}
.dp-text {
  line-height: 1.5;
  word-break: break-word;
}
.dp-tag {
  color: var(--accent-active);
  font-weight: 500;
}
.dp-refined-title {
  font-weight: 500;
  margin-bottom: 2px;
  color: var(--text);
}

/* Refine activity panel (global sidebar status for in-flight refines) */
.dp-activity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
}
.dp-activity-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  color: var(--warning);
}
.dp-activity-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warning);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--warning) 50%, transparent);
  animation: dp-pulse 1.4s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes dp-pulse {
  0%   { opacity: 0.4; transform: scale(0.85); box-shadow: 0 0 0 0 color-mix(in srgb, var(--warning) 50%, transparent); }
  50%  { opacity: 1;   transform: scale(1.15); box-shadow: 0 0 0 6px color-mix(in srgb, var(--warning) 0%, transparent); }
  100% { opacity: 0.4; transform: scale(0.85); box-shadow: 0 0 0 0 color-mix(in srgb, var(--warning) 0%, transparent); }
}
/* "Done" state — dot stops pulsing, switches to success color, panel fades. */
.dp-activity-done {
  background: color-mix(in srgb, var(--success) 8%, transparent);
  transition: opacity 0.4s ease;
  opacity: 0.7;
}
.dp-activity-done .dp-activity-header { color: var(--success); }
.dp-activity-done .dp-activity-dot {
  background: var(--success);
  animation: none;
  box-shadow: none;
}
.dp-activity-list {
  /* Fixed height = 5 lines so older bullets scroll off the top as new ones
     arrive at the bottom. scrollbar-width:none + ::-webkit-scrollbar hides
     the scrollbar chrome on both WebKit and Gecko — the scroll is visual
     only, the user never drives it manually. */
  max-height: calc(5 * 1.5em);
  overflow-y: auto;
  overflow-x: hidden;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.5;
  padding-left: 4px;
  border-left: 2px solid color-mix(in srgb, var(--warning) 60%, transparent);
  scroll-behavior: smooth;
  scrollbar-width: none;
}
.dp-activity-list::-webkit-scrollbar { display: none; }
.dp-activity-done .dp-activity-list {
  border-left-color: color-mix(in srgb, var(--success) 60%, transparent);
}
.dp-activity-bullet {
  padding-left: 8px;
  position: relative;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: dp-bullet-in 0.25s ease-out;
}
.dp-activity-bullet::before {
  content: '\\b7';
  position: absolute;
  left: 0;
  color: var(--warning);
}
.dp-activity-done .dp-activity-bullet::before { color: var(--success); }
@keyframes dp-bullet-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Meta row */
.dp-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.dp-status {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  font-size: 10px;
}
.dp-s-raw { color: var(--text-dim); }
.dp-s-refining, .dp-s-grouped { color: var(--warning); }
.dp-s-refined { color: var(--accent-active); }
.dp-s-needs-info { color: var(--warning); }
.dp-s-active { color: var(--success); }
.dp-s-done { color: var(--success); }
.dp-s-failed { color: var(--danger); }
.dp-s-cancelled { color: var(--text-dim); }
.dp-time { color: var(--text-dim); }
.dp-spacer { flex: 1; }

/* Action buttons */
.dp-action {
  padding: 0 6px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.1s;
}
.dp-action:hover { border-color: var(--text-muted); color: var(--text); }
.dp-act-start { border-color: var(--success); color: var(--success); }
.dp-act-start:hover { background: var(--success); color: var(--bg); }
.dp-act-dismiss { border: none; color: var(--text-dim); font-size: 14px; padding: 0 2px; }
.dp-act-dismiss:hover { color: var(--danger); }
`;
