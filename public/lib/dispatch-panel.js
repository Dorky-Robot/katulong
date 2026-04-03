/**
 * Dispatch Panel
 *
 * Feature queue with batch refinement, inline @project mentions,
 * and visible session integration.
 *
 * Raw ideas can be selected (checkboxes) and batch-refined — Claude
 * triages them into consolidated/split/flagged tickets.
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
  let projectCache = null;
  const selected = new Set(); // selected raw feature IDs for batch refine

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

  const dropdown = el('div', { className: 'dp-autocomplete dp-hidden' });
  composer.appendChild(dropdown);

  panel.appendChild(composer);

  // ── Floating refine bar ─────────────────────────────────────────

  const refineBar = el('div', { className: 'dp-refine-bar dp-hidden' });
  const refineSelectedBtn = el('button', { className: 'dp-refine-btn' });
  const refineAllBtn = el('button', { className: 'dp-refine-btn dp-refine-all' });
  refineBar.appendChild(refineSelectedBtn);
  refineBar.appendChild(refineAllBtn);
  panel.appendChild(refineBar);

  function updateRefineBar() {
    const rawCount = [...features.values()].filter((f) => f.status === 'raw').length;
    const selCount = selected.size;

    if (rawCount === 0) {
      refineBar.classList.add('dp-hidden');
      return;
    }

    refineBar.classList.remove('dp-hidden');
    refineSelectedBtn.textContent = `Refine ${selCount} selected`;
    refineSelectedBtn.disabled = selCount === 0;
    refineAllBtn.textContent = `Refine all (${rawCount})`;
  }

  refineSelectedBtn.addEventListener('click', async () => {
    if (selected.size === 0) return;
    try {
      await api.post('/api/dispatch/refine', { featureIds: [...selected] });
      selected.clear();
      await refreshFeatures();
    } catch (err) {
      console.error('[Dispatch] Batch refine failed:', err);
    }
  });

  refineAllBtn.addEventListener('click', async () => {
    try {
      await api.post('/api/dispatch/refine', { all: true });
      selected.clear();
      await refreshFeatures();
    } catch (err) {
      console.error('[Dispatch] Refine all failed:', err);
    }
  });

  // ── Project autocomplete ─────────────────────────────────────────

  function setProjects(list) {
    if (Array.isArray(list) && list.length > 0) projectCache = list;
  }

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
        return as.length - bs.length;
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
    hint.textContent = projects.length > 0 ? projects.map((p) => `@${p}`).join(' ') : '';
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
      const items = data.features || data;
      features.clear();
      for (const f of (Array.isArray(items) ? items : [])) features.set(f.id, f);
      if (data.projects) setProjects(data.projects);
      // Prune selection — remove IDs that are no longer raw
      for (const id of selected) {
        const f = features.get(id);
        if (!f || f.status !== 'raw') selected.delete(id);
      }
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
      updateRefineBar();
      return;
    }

    for (const f of items) {
      list.appendChild(createCard(f));
    }
    updateRefineBar();
  }

  function createCard(f) {
    const card = el('div', { className: `dp-card dp-status-${f.status}` });

    // Checkbox for raw features (batch selection)
    if (f.status === 'raw') {
      const cb = el('input', { type: 'checkbox', className: 'dp-checkbox' });
      cb.checked = selected.has(f.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(f.id);
        else selected.delete(f.id);
        updateRefineBar();
      });
      card.appendChild(cb);
    }

    // Refined title + project tag
    if (f.refined?.title) {
      card.appendChild(el('div', { className: 'dp-refined-title', textContent: f.refined.title }));
    }
    if (f.project) {
      const projects = Array.isArray(f.project) ? f.project : [f.project];
      const projRow = el('div', { className: 'dp-project-tags' });
      for (const p of projects) {
        projRow.appendChild(el('span', { className: 'dp-tag', textContent: `@${p}` }));
      }
      card.appendChild(projRow);
    }

    // Main text — render @tags as styled spans
    const textEl = el('div', { className: 'dp-text' });
    const parts = (f.body || '').split(/(@[a-zA-Z0-9._-]+)/g);
    for (const part of parts) {
      if (part.startsWith('@')) {
        textEl.appendChild(el('span', { className: 'dp-tag', textContent: part }));
      } else if (part.trim()) {
        textEl.appendChild(document.createTextNode(part));
      }
    }
    card.appendChild(textEl);

    // Lineage — show source ideas for refined features
    if (f.sourceIds && Array.isArray(f.sourceIds) && f.sourceIds.length > 0) {
      const sources = f.sourceIds
        .map((id) => features.get(id))
        .filter(Boolean)
        .map((src) => (src.body || '').slice(0, 40));
      if (sources.length > 0) {
        card.appendChild(el('div', { className: 'dp-lineage', textContent: `from: ${sources.join(', ')}` }));
      }
    }

    // Live progress from Claude Code hooks (appended to body as log lines)
    if (f.body && (f.status === 'grouped' || f.status === 'active')) {
      const logLines = f.body.split('\n').filter((l) => l.startsWith('- ')).slice(-3);
      if (logLines.length > 0) {
        const bullets = el('div', { className: 'dp-bullets' });
        for (const line of logLines) {
          // Strip "- HH:MM:SS " prefix from log lines
          const text = line.replace(/^- \d{2}:\d{2}:\d{2} /, '');
          bullets.appendChild(el('div', { className: 'dp-bullet', textContent: text }));
        }
        card.appendChild(bullets);
      }
    }

    // Meta line — status + time + actions
    const meta = el('div', { className: 'dp-meta' });
    meta.appendChild(el('span', { className: `dp-status dp-s-${f.status}`, textContent: f.status }));
    meta.appendChild(el('span', { className: 'dp-time', textContent: timeAgo(f.created) }));
    meta.appendChild(el('span', { className: 'dp-spacer' }));

    // "Open" button — surface the dispatch session in the carousel
    if (f.sessionName && ['grouped', 'refining', 'active', 'done', 'failed'].includes(f.status)) {
      meta.appendChild(actionBtn('Open', () => {
        document.dispatchEvent(new CustomEvent('dispatch:open-session', { detail: { name: f.sessionName } }));
      }, 'dp-act-open'));
    }

    // Start button for refined features
    if (f.status === 'refined') {
      meta.appendChild(actionBtn('Start', async () => {
        try { await api.post(`/api/dispatch/start/${encodeURIComponent(f.id)}`); await refreshFeatures(); }
        catch (err) { console.error('[Dispatch] Start failed:', err); }
      }, 'dp-act-start'));
    }

    // Dismiss
    meta.appendChild(actionBtn('\u00d7', async () => {
      try { await api.delete(`/api/dispatch/features/${encodeURIComponent(f.id)}`); await refreshFeatures(); }
      catch (err) { console.error('[Dispatch] Dismiss failed:', err); }
    }, 'dp-act-dismiss'));

    card.appendChild(meta);
    return card;
  }

  function actionBtn(label, onclick, cls = '') {
    return el('button', {
      className: `dp-action ${cls}`.trim(),
      textContent: label,
      onClick: onclick,
    });
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
}
.dp-card:hover { background: color-mix(in srgb, var(--bg-surface) 50%, transparent); }
.dp-status-grouped { opacity: 0.6; }
.dp-checkbox {
  float: left;
  margin: 3px 8px 0 0;
  accent-color: var(--accent-active);
  cursor: pointer;
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
.dp-project-tags {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  margin-bottom: 2px;
}
.dp-lineage {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  font-style: italic;
}

/* Meta row */
.dp-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}
.dp-status {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  font-size: 10px;
}
.dp-s-raw { color: var(--text-dim); }
.dp-s-grouped { color: var(--warning); }
.dp-s-refining { color: var(--warning); }
.dp-s-refined { color: var(--accent-active); }
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
.dp-act-open { border-color: var(--accent-active); color: var(--accent-active); }
.dp-act-open:hover { background: var(--accent-active); color: var(--bg); }

/* Refine bar (sticky bottom of list) */
.dp-refine-bar {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-surface);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.dp-refine-btn {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid var(--accent-active);
  border-radius: 6px;
  background: transparent;
  color: var(--accent-active);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.1s;
}
.dp-refine-btn:hover:not(:disabled) { background: var(--accent-active); color: var(--bg); }
.dp-refine-btn:disabled { opacity: 0.4; cursor: default; }
.dp-refine-all { border-color: var(--border); color: var(--text-muted); }
.dp-refine-all:hover { border-color: var(--accent-active); color: var(--accent-active); }

/* Progress bullets */
.dp-bullets {
  margin-top: 4px;
  padding-left: 2px;
}
.dp-bullet {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.6;
}
.dp-bullet::before {
  content: '\\00b7 ';
  color: var(--accent-active);
}
`;
