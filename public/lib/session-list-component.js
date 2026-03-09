/**
 * Reactive Session List Component
 *
 * Renders session preview cards with terminal buffer snapshots.
 * Auto-updates when session store changes.
 */

import { createComponent } from '/lib/component.js';
import { invalidateSessions } from '/lib/stores.js';
import { api } from '/lib/api-client.js';

/**
 * Create session list component
 */
// Shared snapshot cache: sessionName → plain text from xterm buffer
const snapshotCache = new Map();

/**
 * Capture the terminal's text content from xterm's buffer API.
 * This reads the already-parsed text (no ANSI codes) directly from xterm.js.
 */
export function updateSnapshot(sessionName, term) {
  if (!term?.buffer?.active) return;
  try {
    const buf = term.buffer.active;
    const lines = [];
    // Read the last N visible lines from the active buffer
    const startLine = Math.max(0, buf.baseY);
    const endLine = startLine + term.rows;
    for (let i = startLine; i < endLine; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    const text = lines.join("\n");
    if (text.trim()) {
      snapshotCache.set(sessionName, text);
      // Push directly into any visible preview div for this session
      document.querySelectorAll(`.session-card[title="${sessionName}"] .session-card-preview`)
        .forEach(el => { el.textContent = text; });
    }
  } catch { /* buffer not ready */ }
}

export function createSessionListComponent(store, options = {}) {
  const { onSessionSwitch } = options;
  const render = (state) => {
    if (state.loading && state.sessions.length === 0) {
      return '<div class="session-list-status">Loading...</div>';
    }

    if (state.sessions.length === 0) {
      return '<div class="session-list-status">No sessions</div>';
    }

    // Render will happen in afterRender via DOM manipulation
    return '';
  };

  const afterRender = (container, state) => {
    for (const s of state.sessions) {
      const isCurrent = s.name === state.currentSession;

      const card = document.createElement("div");
      card.className = `session-card${isCurrent ? " active" : ""}${s.external ? " external" : ""}`;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-label", `Session: ${s.name}${s.external ? " (external tmux session)" : ""}`);
      card.setAttribute("data-initial", s.name.charAt(0));
      card.title = s.name;

      // Click to switch session
      if (!isCurrent) {
        card.addEventListener("click", (e) => {
          // Don't navigate if clicking an action button
          if (e.target.closest(".session-card-action")) return;
          if (onSessionSwitch) {
            onSessionSwitch(s.name);
          } else {
            location.href = `/?s=${encodeURIComponent(s.name)}`;
          }
        });
      }

      // Terminal preview — cached text from xterm buffer
      const preview = document.createElement("div");
      preview.className = "session-card-preview";
      const cached = snapshotCache.get(s.name);
      if (cached) {
        preview.textContent = cached;
      }
      card.appendChild(preview);

      // Footer with editable name
      const footer = document.createElement("div");
      footer.className = "session-card-footer";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "session-card-name";
      nameInput.value = s.name;
      nameInput.setAttribute("aria-label", `Session name: ${s.name}`);
      nameInput.setAttribute("autocorrect", "off");
      nameInput.setAttribute("autocapitalize", "off");
      nameInput.setAttribute("spellcheck", "false");
      nameInput.readOnly = true;
      const originalName = s.name;

      // Double-click to enable editing
      nameInput.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        nameInput.readOnly = false;
        nameInput.select();
      });

      async function commitRename() {
        nameInput.readOnly = true;
        const newName = nameInput.value.trim();
        if (!newName || newName === originalName) {
          nameInput.value = originalName;
          return;
        }
        try {
          await api.put(`/sessions/${encodeURIComponent(originalName)}`, { name: newName });
          invalidateSessions(store, state.currentSession);
        } catch {
          nameInput.value = originalName;
        }
      }

      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
        if (e.key === "Escape") { nameInput.value = originalName; nameInput.blur(); }
      });
      nameInput.addEventListener("blur", commitRename);
      // Prevent card click-to-navigate when interacting with name
      nameInput.addEventListener("click", (e) => e.stopPropagation());
      footer.appendChild(nameInput);

      card.appendChild(footer);

      // Action buttons (shown on hover)
      const actions = document.createElement("div");
      actions.className = "session-card-actions";

      if (s.external) {
        // External tmux session — show eject button (detach from katulong, keep tmux session)
        const ejectBtn = document.createElement("button");
        ejectBtn.className = "session-card-action";
        ejectBtn.setAttribute("aria-label", `Detach session ${s.name} from katulong`);
        ejectBtn.innerHTML = '<i class="ph ph-eject"></i>';
        ejectBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await api.delete(`/sessions/${encodeURIComponent(s.name)}`);
            invalidateSessions(store, state.currentSession);
          } catch (err) {
            console.error('[Session] Detach failed:', err);
          }
        });
        actions.appendChild(ejectBtn);
      } else {
        // Katulong-managed session — show delete button
        const delBtn = document.createElement("button");
        delBtn.className = "session-card-action delete";
        delBtn.setAttribute("aria-label", `Delete session ${s.name}`);
        delBtn.innerHTML = '<i class="ph ph-trash"></i>';
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (s.hasChildProcesses) {
            const confirmed = confirm(
              `Session "${s.name}" contains running processes or important content (like Claude Code history). Deleting it will lose this data.\n\nAre you sure you want to delete this session?`
            );
            if (!confirmed) return;
          }
          try {
            await api.delete(`/sessions/${encodeURIComponent(s.name)}`);
            invalidateSessions(store, state.currentSession);
          } catch (err) {
            console.error('[Session] Delete failed:', err);
          }
        });
        actions.appendChild(delBtn);
      }

      card.appendChild(actions);
      container.appendChild(card);
    }
  };

  return createComponent(store, render, { afterRender });
}
