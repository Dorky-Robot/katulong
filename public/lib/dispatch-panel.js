/**
 * Dispatch Panel
 *
 * Sidebar panel for managing the dispatch feature queue.
 * Renders input bar, raw ideas, refined specs, and active work sections.
 * Connects to SSE stream for real-time updates.
 */

import { api } from '/lib/api-client.js';

// ── Status badge colors ──────────────────────────────────────────────
const STATUS_COLORS = {
  raw:      { bg: 'var(--accent)',    text: 'var(--text-muted)' },
  refining: { bg: 'var(--warning)',   text: 'var(--bg)',         pulse: true },
  refined:  { bg: 'var(--accent-active)', text: 'var(--bg)' },
  active:   { bg: 'var(--success)',   text: 'var(--bg)',         pulse: true },
  done:     { bg: 'var(--success)',   text: 'var(--bg)' },
  failed:   { bg: 'var(--danger)',    text: 'var(--bg)' },
};

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'textContent') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function badge(status) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.raw;
  const node = el('span', {
    className: `dp-badge${colors.pulse ? ' dp-pulse' : ''}`,
    textContent: status,
  });
  node.style.background = colors.bg;
  node.style.color = colors.text;
  return node;
}

function iconBtn(iconClass, label, onClick, extraClass = '') {
  const btn = el('button', {
    className: `btn btn--sm dp-btn ${extraClass}`.trim(),
    'aria-label': label,
    onClick,
  }, [el('i', { className: iconClass })]);
  return btn;
}

function textBtn(text, onClick, extraClass = '') {
  return el('button', {
    className: `btn btn--sm dp-btn ${extraClass}`.trim(),
    textContent: text,
    onClick,
  });
}

// ── Collapsible section ──────────────────────────────────────────────

function createSection(title, initiallyOpen = true) {
  let open = initiallyOpen;
  const body = el('div', { className: 'dp-section-body' });
  const chevron = el('i', { className: 'ph ph-caret-down dp-section-chevron' });
  const countBadge = el('span', { className: 'dp-section-count', textContent: '0' });

  const header = el('button', {
    className: 'dp-section-header',
    onClick: () => {
      open = !open;
      update();
    },
  }, [chevron, el('span', { textContent: title }), countBadge]);

  const section = el('div', { className: 'dp-section' }, [header, body]);

  function update() {
    body.style.display = open ? '' : 'none';
    chevron.style.transform = open ? '' : 'rotate(-90deg)';
  }
  update();

  return {
    el: section,
    body,
    setCount(n) { countBadge.textContent = String(n); },
    clear() { body.textContent = ''; },
  };
}

// ── Feature state ────────────────────────────────────────────────────

/**
 * @typedef {Object} Feature
 * @property {string} id
 * @property {string} raw
 * @property {string} status - raw|refining|refined|active|done|failed
 * @property {string} [title]
 * @property {string} [project]
 * @property {number} [subtaskCount]
 * @property {number} [estimatedAgents]
 * @property {string} [currentPhase]
 * @property {string} [latestLog]
 */

// ── Main export ──────────────────────────────────────────────────────

export function createDispatchPanel(container) {
  /** @type {Map<string, Feature>} */
  const features = new Map();
  let eventSource = null;
  let destroyed = false;

  // ── Inject scoped styles ─────────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = PANEL_CSS;
  document.head.appendChild(styleEl);

  // ── Build DOM structure ──────────────────────────────────────────
  const panel = el('div', { className: 'dp-panel' });

  // Input bar
  const input = el('input', {
    className: 'dp-input',
    type: 'text',
    placeholder: 'Feature idea\u2026',
    'aria-label': 'New feature idea',
    autocomplete: 'off',
  });
  const submitBtn = el('button', {
    className: 'btn btn--primary btn--sm dp-submit',
    'aria-label': 'Submit feature idea',
  }, [el('i', { className: 'ph ph-paper-plane-tilt' })]);

  const inputBar = el('div', { className: 'dp-input-bar' }, [input, submitBtn]);
  panel.appendChild(inputBar);

  async function submitIdea() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;
    submitBtn.disabled = true;
    try {
      await api.post('/api/dispatch/features', { raw: text });
    } catch (err) {
      console.error('[Dispatch] Submit failed:', err);
      input.value = text; // restore on failure
    } finally {
      input.disabled = false;
      submitBtn.disabled = false;
      input.focus();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitIdea(); }
  });
  submitBtn.addEventListener('click', submitIdea);

  // Sections
  const rawSection = createSection('Raw Ideas', true);
  const refinedSection = createSection('Refined Specs', true);
  const activeSection = createSection('Active Work', true);

  panel.appendChild(rawSection.el);
  panel.appendChild(refinedSection.el);
  panel.appendChild(activeSection.el);

  container.appendChild(panel);

  // ── Rendering ────────────────────────────────────────────────────

  function renderAll() {
    if (destroyed) return;

    const raw = [];
    const refined = [];
    const active = [];

    for (const f of features.values()) {
      if (f.status === 'raw' || f.status === 'refining') raw.push(f);
      else if (f.status === 'refined') refined.push(f);
      else if (f.status === 'active' || f.status === 'done' || f.status === 'failed') active.push(f);
    }

    renderRawSection(raw);
    renderRefinedSection(refined);
    renderActiveSection(active);
  }

  function renderRawSection(items) {
    rawSection.clear();
    rawSection.setCount(items.length);
    if (items.length === 0) {
      rawSection.body.appendChild(el('div', {
        className: 'dp-empty',
        textContent: 'No raw ideas',
      }));
      return;
    }
    for (const f of items) {
      rawSection.body.appendChild(createRawCard(f));
    }
  }

  function createRawCard(f) {
    const card = el('div', { className: 'dp-card' });
    const top = el('div', { className: 'dp-card-top' }, [
      badge(f.status),
      el('span', { className: 'dp-card-text', textContent: truncate(f.raw) }),
    ]);
    card.appendChild(top);

    const actions = el('div', { className: 'dp-card-actions' });
    if (f.status === 'raw') {
      actions.appendChild(textBtn('Refine', async () => {
        try { await api.post(`/api/dispatch/refine/${encodeURIComponent(f.id)}`); }
        catch (err) { console.error('[Dispatch] Refine failed:', err); }
      }));
    }
    actions.appendChild(iconBtn('ph ph-x', 'Dismiss', async () => {
      try { await api.delete(`/api/dispatch/features/${encodeURIComponent(f.id)}`); }
      catch (err) { console.error('[Dispatch] Dismiss failed:', err); }
    }, 'dp-btn-dismiss'));
    card.appendChild(actions);

    return card;
  }

  function renderRefinedSection(items) {
    refinedSection.clear();
    refinedSection.setCount(items.length);
    if (items.length === 0) {
      refinedSection.body.appendChild(el('div', {
        className: 'dp-empty',
        textContent: 'No refined specs',
      }));
      return;
    }
    for (const f of items) {
      refinedSection.body.appendChild(createRefinedCard(f));
    }
  }

  function createRefinedCard(f) {
    const card = el('div', { className: 'dp-card' });

    const top = el('div', { className: 'dp-card-top' });
    if (f.project) {
      top.appendChild(el('span', { className: 'dp-project-badge', textContent: f.project }));
    }
    top.appendChild(el('span', {
      className: 'dp-card-title',
      textContent: f.title || truncate(f.raw),
    }));
    card.appendChild(top);

    const meta = el('div', { className: 'dp-card-meta' });
    if (f.subtaskCount != null) {
      meta.appendChild(el('span', { textContent: `${f.subtaskCount} subtask${f.subtaskCount !== 1 ? 's' : ''}` }));
    }
    if (f.estimatedAgents != null) {
      meta.appendChild(el('span', { textContent: `${f.estimatedAgents} agent${f.estimatedAgents !== 1 ? 's' : ''}` }));
    }
    if (meta.childNodes.length > 0) card.appendChild(meta);

    const actions = el('div', { className: 'dp-card-actions' });
    actions.appendChild(textBtn('Start', async () => {
      try { await api.post(`/api/dispatch/start/${encodeURIComponent(f.id)}`); }
      catch (err) { console.error('[Dispatch] Start failed:', err); }
    }, 'dp-btn-start'));
    actions.appendChild(iconBtn('ph ph-pencil-simple', 'Edit', () => {
      toggleEditMode(card, f);
    }));
    actions.appendChild(iconBtn('ph ph-x', 'Dismiss', async () => {
      try { await api.delete(`/api/dispatch/features/${encodeURIComponent(f.id)}`); }
      catch (err) { console.error('[Dispatch] Dismiss failed:', err); }
    }, 'dp-btn-dismiss'));
    card.appendChild(actions);

    return card;
  }

  function toggleEditMode(card, f) {
    // If already in edit mode, bail
    if (card.querySelector('.dp-edit-area')) return;

    const textarea = el('textarea', {
      className: 'dp-edit-area',
    });
    textarea.value = f.raw || f.title || '';
    textarea.rows = 3;

    const saveBtn = textBtn('Save', async () => {
      const newText = textarea.value.trim();
      if (!newText) return;
      try {
        await api.put(`/api/dispatch/features/${encodeURIComponent(f.id)}`, { raw: newText });
      } catch (err) {
        console.error('[Dispatch] Edit save failed:', err);
      }
    });

    const cancelBtn = textBtn('Cancel', () => {
      editRow.remove();
    });

    const editRow = el('div', { className: 'dp-edit-row' }, [textarea, el('div', { className: 'dp-edit-btns' }, [saveBtn, cancelBtn])]);
    card.appendChild(editRow);
    textarea.focus();
  }

  function renderActiveSection(items) {
    activeSection.clear();
    activeSection.setCount(items.length);
    if (items.length === 0) {
      activeSection.body.appendChild(el('div', {
        className: 'dp-empty',
        textContent: 'No active work',
      }));
      return;
    }

    // Group by project
    const groups = new Map();
    for (const f of items) {
      const proj = f.project || 'default';
      if (!groups.has(proj)) groups.set(proj, []);
      groups.get(proj).push(f);
    }

    for (const [project, group] of groups) {
      const groupEl = el('div', { className: 'dp-active-group' });
      groupEl.appendChild(el('div', { className: 'dp-group-header', textContent: project }));
      for (const f of group) {
        groupEl.appendChild(createActiveCard(f));
      }
      activeSection.body.appendChild(groupEl);
    }
  }

  function createActiveCard(f) {
    const card = el('div', { className: `dp-card dp-active-card${f.status === 'active' ? ' dp-active-pulse' : ''}` });

    const top = el('div', { className: 'dp-card-top' }, [
      badge(f.status),
      el('span', {
        className: 'dp-card-title',
        textContent: f.title || truncate(f.raw),
      }),
    ]);
    card.appendChild(top);

    if (f.currentPhase) {
      card.appendChild(el('div', { className: 'dp-phase', textContent: f.currentPhase }));
    }
    if (f.latestLog) {
      card.appendChild(el('div', { className: 'dp-log', textContent: truncate(f.latestLog, 120) }));
    }

    return card;
  }

  // ── SSE connection ───────────────────────────────────────────────

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
        renderAll();
      } catch (err) {
        console.error('[Dispatch] Snapshot parse error:', err);
      }
    });

    eventSource.addEventListener('feature-added', (e) => {
      try {
        const data = JSON.parse(e.data);
        const f = data.feature;
        if (f) { features.set(f.id, f); renderAll(); }
      } catch (err) {
        console.error('[Dispatch] feature-added parse error:', err);
      }
    });

    eventSource.addEventListener('feature-updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        const f = data.feature;
        if (!f) return;
        if (features.has(f.id)) {
          features.set(f.id, { ...features.get(f.id), ...f });
        } else {
          features.set(f.id, f);
        }
        renderAll();
      } catch (err) {
        console.error('[Dispatch] feature-updated parse error:', err);
      }
    });

    eventSource.addEventListener('feature-deleted', (e) => {
      try {
        const data = JSON.parse(e.data);
        features.delete(data.id);
        renderAll();
      } catch (err) {
        console.error('[Dispatch] feature-deleted parse error:', err);
      }
    });

    eventSource.addEventListener('hook', (e) => {
      try {
        const data = JSON.parse(e.data);
        const f = features.get(data.featureId);
        if (f) {
          if (data.phase) f.currentPhase = data.phase;
          if (data.detail) f.latestLog = data.detail;
          renderAll();
        }
      } catch (err) {
        console.error('[Dispatch] hook parse error:', err);
      }
    });

    eventSource.onerror = () => {
      // EventSource auto-reconnects; just log
      console.warn('[Dispatch] SSE connection error, will retry');
    };
  }

  connectSSE();

  // ── Cleanup ──────────────────────────────────────────────────────

  function destroy() {
    destroyed = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    if (panel.parentNode) panel.parentNode.removeChild(panel);
  }

  return { destroy };
}

// ── Scoped CSS ───────────────────────────────────────────────────────

const PANEL_CSS = `
/* Dispatch Panel */
.dp-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm);
  font-size: var(--text-sm);
  overflow-y: auto;
  height: 100%;
}

/* Input bar */
.dp-input-bar {
  display: flex;
  gap: var(--space-xs);
  flex-shrink: 0;
}
.dp-input {
  flex: 1;
  height: var(--height-btn-sm);
  padding: 0 var(--space-sm);
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: var(--text-sm);
  outline: none;
}
.dp-input:focus {
  border-color: var(--accent-active);
}
.dp-submit {
  flex-shrink: 0;
  width: var(--height-btn-sm);
  padding: 0;
}

/* Sections */
.dp-section {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.dp-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  width: 100%;
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-surface);
  border: none;
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dp-section-header:hover {
  color: var(--text);
}
.dp-section-chevron {
  font-size: var(--text-xs);
  transition: transform var(--transition-fast);
}
.dp-section-count {
  margin-left: auto;
  background: var(--accent);
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-xs);
  font-size: 0.6875rem;
  min-width: 1.25rem;
  text-align: center;
}
.dp-section-body {
  padding: var(--space-xs);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

/* Cards */
.dp-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-xs) var(--space-sm);
}
.dp-card-top {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 1.5rem;
}
.dp-card-text,
.dp-card-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: var(--text-sm);
}
.dp-card-title {
  font-weight: var(--font-medium);
}
.dp-card-meta {
  display: flex;
  gap: var(--space-sm);
  padding-top: var(--space-xs);
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.dp-card-actions {
  display: flex;
  gap: var(--space-xs);
  padding-top: var(--space-xs);
  justify-content: flex-end;
}

/* Buttons */
.dp-btn {
  height: 1.5rem;
  padding: 0 var(--space-sm);
  font-size: var(--text-xs);
}
.dp-btn-dismiss {
  color: var(--text-dim);
}
.dp-btn-dismiss:hover {
  color: var(--danger);
}
.dp-btn-start {
  background: var(--success);
  color: var(--bg);
}
.dp-btn-start:hover {
  opacity: var(--opacity-hover);
}

/* Badge */
.dp-badge {
  display: inline-block;
  padding: 0 var(--space-xs);
  border-radius: var(--radius-sm);
  font-size: 0.6875rem;
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  line-height: 1.5;
  flex-shrink: 0;
}

/* Project badge */
.dp-project-badge {
  background: var(--accent);
  color: var(--text-muted);
  padding: 0 var(--space-xs);
  border-radius: var(--radius-sm);
  font-size: 0.6875rem;
  font-weight: var(--font-medium);
  flex-shrink: 0;
}

/* Pulse animation */
@keyframes dp-pulse-anim {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
.dp-pulse {
  animation: dp-pulse-anim 2s ease-in-out infinite;
}
.dp-active-pulse {
  border-left: 2px solid var(--success);
}

/* Active work */
.dp-active-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.dp-group-header {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: var(--space-xs) 0 0;
}
.dp-phase {
  font-size: var(--text-xs);
  color: var(--accent-active);
  padding-top: 2px;
}
.dp-log {
  font-size: var(--text-xs);
  color: var(--text-dim);
  padding-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Edit mode */
.dp-edit-row {
  padding-top: var(--space-xs);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.dp-edit-area {
  width: 100%;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-xs) var(--space-sm);
  font-family: inherit;
  font-size: var(--text-sm);
  resize: vertical;
  outline: none;
}
.dp-edit-area:focus {
  border-color: var(--accent-active);
}
.dp-edit-btns {
  display: flex;
  gap: var(--space-xs);
  justify-content: flex-end;
}

/* Empty state */
.dp-empty {
  color: var(--text-dim);
  font-size: var(--text-xs);
  text-align: center;
  padding: var(--space-sm);
}
`;
