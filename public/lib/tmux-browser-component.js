/**
 * Tmux Browser Component
 *
 * Shows available tmux sessions on the host that are not currently
 * managed by katulong. Allows adopting them into katulong.
 */

import { api } from '/lib/api-client.js';
import { invalidateSessions } from '/lib/stores.js';

export function createTmuxBrowserComponent(sessionStore, options = {}) {
  const { onSessionSwitch } = options;
  let container = null;
  let expanded = false;
  let loading = false;
  let sessions = [];

  function render() {
    if (!container) return;

    if (!expanded) {
      container.innerHTML = '';
      const btn = document.createElement("button");
      btn.className = "tmux-browse-btn";
      btn.title = "Browse tmux sessions";
      btn.innerHTML = '<i class="ph ph-stack"></i><span class="tmux-browse-label"> Browse tmux sessions</span>';
      btn.addEventListener("click", () => {
        expanded = true;
        refresh();
      });
      container.appendChild(btn);
      return;
    }

    container.innerHTML = '';

    const btn = document.createElement("button");
    btn.className = "tmux-browse-btn tmux-browse-btn--active";
    btn.title = "Hide tmux sessions";
    const label = loading ? "Loading\u2026" : "tmux sessions";
    btn.innerHTML = `<i class="ph ph-stack"></i><span class="tmux-browse-label"> ${label}</span>`;
    btn.addEventListener("click", () => {
      expanded = false;
      render();
    });
    container.appendChild(btn);

    if (loading) return;

    if (sessions.length === 0) {
      const msg = document.createElement("div");
      msg.className = "tmux-no-sessions sidebar-hide-collapsed";
      msg.textContent = "No unmanaged tmux sessions found";
      container.appendChild(msg);
      return;
    }

    const list = document.createElement("div");
    list.className = "tmux-session-list sidebar-hide-collapsed";

    for (const name of sessions) {
      const item = document.createElement("div");
      item.className = "tmux-session-item";

      const label = document.createElement("span");
      label.textContent = name;
      item.appendChild(label);

      const attachBtn = document.createElement("button");
      attachBtn.textContent = "Attach";
      attachBtn.addEventListener("click", async () => {
        attachBtn.disabled = true;
        attachBtn.textContent = "\u2026";
        try {
          const result = await api.post("/tmux-sessions/adopt", { name });
          if (result.name) {
            invalidateSessions(sessionStore);
            if (onSessionSwitch) onSessionSwitch(result.name);
            await refresh();
          }
        } catch (err) {
          console.error("[tmux-browser] Adopt failed:", err);
          attachBtn.disabled = false;
          attachBtn.textContent = "Attach";
        }
      });
      item.appendChild(attachBtn);
      list.appendChild(item);
    }

    container.appendChild(list);
  }

  async function refresh() {
    loading = true;
    render();
    try {
      sessions = await api.get("/tmux-sessions");
    } catch (err) {
      console.error("[tmux-browser] Failed to list tmux sessions:", err);
      sessions = [];
    }
    loading = false;
    render();
  }

  return {
    mount(el) {
      container = el;
      render();
    },
    unmount() {
      if (container) container.innerHTML = '';
      container = null;
    }
  };
}
