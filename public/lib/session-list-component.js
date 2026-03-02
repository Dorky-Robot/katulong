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
export function createSessionListComponent(store, options = {}) {
  const { onSessionSwitch } = options;
  const render = (state) => {
    if (state.loading && state.sessions.length === 0) {
      return '<div style="padding:0.5rem;color:var(--text-dim);font-size:0.75rem">Loading...</div>';
    }

    if (state.sessions.length === 0) {
      return '<div style="padding:0.5rem;color:var(--text-dim);font-size:0.75rem">No sessions</div>';
    }

    // Render will happen in afterRender via DOM manipulation
    return '';
  };

  const afterRender = (container, state) => {
    for (const s of state.sessions) {
      const isCurrent = s.name === state.currentSession;

      const card = document.createElement("div");
      card.className = `session-card${isCurrent ? " active" : ""}`;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-label", `Session: ${s.name}`);
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

      // Terminal preview area
      const preview = document.createElement("div");
      preview.className = "session-card-preview";
      preview.textContent = s.preview || "";
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

      // SSH copy
      const sshBtn = document.createElement("button");
      sshBtn.className = "session-card-action";
      sshBtn.setAttribute("aria-label", `Copy SSH command for ${s.name}`);
      sshBtn.innerHTML = '<i class="ph ph-terminal"></i>';
      sshBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const cmd = `ssh ${s.name}@${state.sshInfo.sshHost} -p ${state.sshInfo.sshPort}`;
        try {
          await navigator.clipboard.writeText(cmd);
          sshBtn.innerHTML = '<i class="ph ph-check"></i>';
          sshBtn.style.color = "var(--success)";
          setTimeout(() => {
            sshBtn.innerHTML = '<i class="ph ph-terminal"></i>';
            sshBtn.style.color = "";
          }, 1500);
        } catch {
          /* clipboard not available */
        }
      });
      actions.appendChild(sshBtn);

      // Delete
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

      card.appendChild(actions);
      container.appendChild(card);
    }
  };

  return createComponent(store, render, { afterRender });
}
