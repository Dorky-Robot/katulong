/**
 * Reactive Session List Component
 *
 * Auto-updates when session store changes.
 */

import { createComponent } from '/lib/component.js';
import { invalidateSessions } from '/lib/session-store.js';

/**
 * Create session list component
 */
export function createSessionListComponent(store) {
  const render = (state) => {
    if (state.loading && state.sessions.length === 0) {
      return '<div class="session-item">Loading sessions...</div>';
    }

    if (state.sessions.length === 0) {
      return '<div class="session-item">No sessions</div>';
    }

    // Render will happen in afterRender via DOM manipulation
    // (keeping existing structure for compatibility)
    return '';
  };

  const afterRender = (container, state) => {
    container.innerHTML = '';

    for (const s of state.sessions) {
      const row = document.createElement("div");
      row.className = "session-item";
      row.setAttribute("role", "listitem");

      // Status dot
      const dot = document.createElement("span");
      dot.className = `session-status ${s.alive ? "alive" : "dead"}`;
      dot.setAttribute("aria-label", s.alive ? "Running" : "Exited");
      row.appendChild(dot);

      // Editable name input
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "session-name-input";
      nameInput.value = s.name;
      nameInput.setAttribute("aria-label", `Session name: ${s.name}`);
      nameInput.setAttribute("autocorrect", "off");
      nameInput.setAttribute("autocapitalize", "off");
      nameInput.setAttribute("spellcheck", "false");
      const originalName = s.name;

      async function commitRename() {
        const newName = nameInput.value.trim();
        if (!newName || newName === originalName) {
          nameInput.value = originalName;
          return;
        }

        try {
          const res = await fetch(`/sessions/${encodeURIComponent(originalName)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName }),
          });

          if (!res.ok) {
            nameInput.value = originalName;
            return;
          }

          invalidateSessions(store, state.currentSession);
        } catch {
          nameInput.value = originalName;
        }
      }

      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
        if (e.key === "Escape") {
          nameInput.value = originalName;
          nameInput.blur();
        }
      });
      nameInput.addEventListener("blur", commitRename);
      row.appendChild(nameInput);

      // Current session tag or switch button
      if (s.name === state.currentSession) {
        const cur = document.createElement("span");
        cur.className = "session-current-tag";
        cur.textContent = "(current)";
        row.appendChild(cur);
      } else {
        const openBtn = document.createElement("button");
        openBtn.className = "session-icon-btn open";
        openBtn.setAttribute("aria-label", `Switch to ${s.name}`);
        openBtn.innerHTML = '<i class="ph ph-arrow-right"></i>';
        openBtn.addEventListener("click", () => {
          location.href = `/?s=${encodeURIComponent(s.name)}`;
        });
        row.appendChild(openBtn);
      }

      // SSH command copy button
      const sshBtn = document.createElement("button");
      sshBtn.className = "session-icon-btn ssh";
      sshBtn.setAttribute("aria-label", `Copy SSH command for ${s.name}`);
      sshBtn.innerHTML = '<i class="ph ph-terminal"></i>';
      sshBtn.addEventListener("click", async () => {
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
      row.appendChild(sshBtn);

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.className = "session-icon-btn delete";
      delBtn.setAttribute("aria-label", `Delete session ${s.name}`);
      delBtn.innerHTML = '<i class="ph ph-trash"></i>';
      delBtn.addEventListener("click", async () => {
        // Warn if session has child processes
        if (s.hasChildProcesses) {
          const confirmed = confirm(
            `Session "${s.name}" contains running processes or important content (like Claude Code history). Deleting it will lose this data.\n\nAre you sure you want to delete this session?`
          );
          if (!confirmed) return;
        }

        try {
          await fetch(`/sessions/${encodeURIComponent(s.name)}`, {
            method: "DELETE"
          });
          invalidateSessions(store, state.currentSession);
        } catch (err) {
          console.error('[Session] Delete failed:', err);
        }
      });
      row.appendChild(delBtn);

      container.appendChild(row);
    }
  };

  return createComponent(store, render, { afterRender });
}
