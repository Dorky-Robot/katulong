/**
 * Reactive Session List Component
 *
 * Renders session preview cards with terminal buffer snapshots.
 * Auto-updates when session store changes.
 */

import { createComponent } from '/lib/component.js';
import { invalidateSessions } from '/lib/stores.js';
import { api } from '/lib/api-client.js';

const DIVIDER_CLASS = "session-list-divider";

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
      const escaped = CSS.escape(sessionName);
      document.querySelectorAll(`.session-card[title="${escaped}"] .session-card-preview`)
        .forEach(el => { el.textContent = text; });
    }
  } catch { /* buffer not ready */ }
}

export function createSessionListComponent(store, options = {}) {
  const { onSessionSwitch, windowTabSet } = options;
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

      // Action buttons — always visible (mobile-friendly)
      const actions = document.createElement("div");
      actions.className = "session-card-actions";

      // Helper: after removing a session, switch to the closest remaining one
      function switchAfterRemove(removedName) {
        const removingCurrent = removedName === state.currentSession;
        if (!removingCurrent) {
          invalidateSessions(store, state.currentSession);
          return;
        }
        // Find the closest session to switch to
        const idx = state.sessions.findIndex(x => x.name === removedName);
        const remaining = state.sessions.filter(x => x.name !== removedName);
        if (remaining.length === 0) {
          // No sessions left — navigate to home to create a new one
          location.href = "/";
          return;
        }
        // Pick the next session, or the previous if we were last
        const safeIdx = idx === -1 ? 0 : idx;
        const next = remaining[Math.min(safeIdx, remaining.length - 1)];
        location.href = `/?s=${encodeURIComponent(next.name)}`;
      }

      // Detach button — removes from katulong but keeps tmux session alive
      const detachBtn = document.createElement("button");
      detachBtn.className = "session-card-action";
      detachBtn.setAttribute("aria-label", `Detach session ${s.name}`);
      detachBtn.innerHTML = '<i class="ph ph-eject"></i>';
      detachBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await api.delete(`/sessions/${encodeURIComponent(s.name)}?action=detach`);
          if (windowTabSet) windowTabSet.onSessionKilled(s.name);
          switchAfterRemove(s.name);
        } catch (err) {
          console.error('[Session] Detach failed:', err);
        }
      });
      actions.appendChild(detachBtn);

      // Delete button — kills the tmux session (always confirms)
      const delBtn = document.createElement("button");
      delBtn.className = "session-card-action delete";
      delBtn.setAttribute("aria-label", `Delete session ${s.name}`);
      delBtn.innerHTML = '<i class="ph ph-trash"></i>';
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const message = s.hasChildProcesses
          ? `Session "${s.name}" has running processes. Deleting it will lose this data.\n\nAre you sure?`
          : `Delete session "${s.name}"?\n\nThis will kill the tmux session.`;
        if (!confirm(message)) return;
        try {
          await api.delete(`/sessions/${encodeURIComponent(s.name)}`);
          if (windowTabSet) windowTabSet.onSessionKilled(s.name);
          switchAfterRemove(s.name);
        } catch (err) {
          console.error('[Session] Delete failed:', err);
        }
      });
      actions.appendChild(delBtn);

      footer.appendChild(actions);
      container.appendChild(card);
    }

    // Unmanaged tmux sessions — shown below a divider
    if (state.unmanagedSessions?.length > 0) {
      const divider = document.createElement("div");
      divider.className = DIVIDER_CLASS;
      container.appendChild(divider);

      for (const s of state.unmanagedSessions) {
        const card = document.createElement("div");
        card.className = "session-card unmanaged";
        card.setAttribute("role", "listitem");
        card.setAttribute("aria-label", `Unmanaged tmux session: ${s.name}`);
        card.setAttribute("data-initial", s.name.charAt(0));
        card.title = s.name;

        async function adoptSession() {
          card.style.opacity = "0.5";
          card.style.pointerEvents = "none";
          try {
            const result = await api.post("/tmux-sessions/adopt", { name: s.name });
            if (result.name) {
              if (onSessionSwitch) onSessionSwitch(result.name);
              invalidateSessions(store, result.name);
            }
          } catch (err) {
            console.error("[Session] Adopt failed:", err);
            card.style.opacity = "";
            card.style.pointerEvents = "";
          }
        }

        card.addEventListener("click", adoptSession);

        const row = document.createElement("div");
        row.className = "session-card-row";

        const nameSpan = document.createElement("span");
        nameSpan.className = "session-card-name";
        nameSpan.textContent = s.name;
        row.appendChild(nameSpan);

        const attachBtn = document.createElement("button");
        attachBtn.className = "session-card-action";
        attachBtn.setAttribute("aria-label", `Attach session ${s.name}`);
        attachBtn.innerHTML = '<i class="ph ph-plug"></i>';
        attachBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          adoptSession();
        });
        row.appendChild(attachBtn);

        card.appendChild(row);
        container.appendChild(card);
      }
    }
  };

  return createComponent(store, render, { afterRender });
}
