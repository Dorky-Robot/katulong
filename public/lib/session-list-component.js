/**
 * Reactive Session List Component
 *
 * Renders session preview cards with terminal buffer snapshots.
 * Auto-updates when session store changes.
 * Supports touch drag-and-drop reordering on mobile.
 */

import { createComponent } from '/lib/component.js';
import { invalidateSessions } from '/lib/stores.js';
import { api, invalidateSessionIdCache } from '/lib/api-client.js';

const DIVIDER_CLASS = "session-list-divider";
const LONG_PRESS_MS = 300;
const DRAG_DEAD_ZONE = 5;

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

  // ── Drag state ──────────────────────────────────────────────────────
  let drag = null;

  function orderByTabs(sessions) {
    if (!windowTabSet) return sessions;
    const tabOrder = windowTabSet.getTabs();
    const orderMap = new Map(tabOrder.map((name, i) => [name, i]));
    return [...sessions].sort((a, b) => {
      const ai = orderMap.has(a.name) ? orderMap.get(a.name) : Infinity;
      const bi = orderMap.has(b.name) ? orderMap.get(b.name) : Infinity;
      return ai - bi;
    });
  }

  function onCardTouchStart(e, card, name, container) {
    if (e.target.closest(".session-card-action") || e.target.closest(".session-card-name:not([readonly])")) return;

    const initialTouch = e.touches[0];
    const startX = initialTouch.clientX;
    const startY = initialTouch.clientY;
    let longPressed = false;
    let started = false;
    let cancelled = false;

    const longPressTimer = setTimeout(() => {
      longPressed = true;
      card.classList.add("session-card-long-press");
    }, LONG_PRESS_MS);

    const onMove = (te) => {
      const touch = te.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!longPressed) {
        // Movement before long press — cancel drag, allow native scroll
        if (Math.abs(dx) > DRAG_DEAD_ZONE || Math.abs(dy) > DRAG_DEAD_ZONE) {
          clearTimeout(longPressTimer);
          cancelled = true;
          cleanup();
        }
        return;
      }

      // Long press active — enter drag mode
      if (!started) {
        if (Math.abs(dx) < DRAG_DEAD_ZONE && Math.abs(dy) < DRAG_DEAD_ZONE) return;
        started = true;
        beginDrag(card, name, startY, container);
      }

      te.preventDefault();
      updateDrag(touch.clientY);
    };

    const onEnd = () => {
      clearTimeout(longPressTimer);
      card.classList.remove("session-card-long-press");
      cleanup();

      if (cancelled) return;

      if (!started) {
        // Long press without drag — no special action, just cancel
        if (longPressed) return;
        // Short tap — handled by click handler
        return;
      }

      endDrag(container);
    };

    function cleanup() {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    }

    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
  }

  function beginDrag(card, name, startY, container) {
    const cards = [...container.querySelectorAll(".session-card:not(.unmanaged)")];
    const dragIndex = cards.indexOf(card);
    if (dragIndex === -1) return;

    const rects = cards.map(c => {
      const r = c.getBoundingClientRect();
      return { top: r.top, height: r.height, center: r.top + r.height / 2 };
    });

    const cardRect = card.getBoundingClientRect();

    const ghost = card.cloneNode(true);
    ghost.classList.add("session-card-drag-ghost");
    ghost.style.width = cardRect.width + "px";
    ghost.style.height = rects[dragIndex].height + "px";
    ghost.style.left = cardRect.left + "px";
    ghost.style.overflow = "visible";
    document.body.appendChild(ghost);

    card.classList.add("session-card-dragging");

    cards.forEach((c, i) => {
      if (i !== dragIndex) c.style.transition = "transform 0.2s ease";
    });

    const grabOffset = startY - rects[dragIndex].top;

    drag = {
      card, name, ghost, cards, rects, dragIndex,
      currentIndex: dragIndex,
      grabOffset,
    };
  }

  function updateDrag(cy) {
    if (!drag) return;
    const { ghost, cards, rects, dragIndex, grabOffset } = drag;

    const gy = cy - grabOffset;
    ghost.style.transform = `translate3d(0, ${gy}px, 0)`;

    const dragHeight = rects[dragIndex].height;

    let newIndex = rects.length - 1;
    for (let i = 0; i < rects.length; i++) {
      if (cy < rects[i].center) {
        newIndex = i;
        break;
      }
    }
    if (newIndex > rects.length - 1) newIndex = rects.length - 1;

    drag.currentIndex = newIndex;

    const gap = parseFloat(getComputedStyle(cards[0].parentElement).gap) || 8;

    for (let i = 0; i < cards.length; i++) {
      if (i === dragIndex) continue;

      let shift = 0;
      if (dragIndex < newIndex) {
        if (i > dragIndex && i <= newIndex) {
          shift = -(dragHeight + gap);
        }
      } else if (dragIndex > newIndex) {
        if (i >= newIndex && i < dragIndex) {
          shift = dragHeight + gap;
        }
      }

      cards[i].style.transform = shift ? `translateY(${shift}px)` : "";
    }
  }

  function endDrag(container) {
    if (!drag) return;
    const { card, ghost, cards, dragIndex, currentIndex } = drag;

    ghost.remove();

    cards.forEach(c => {
      c.style.transition = "";
      c.style.transform = "";
    });

    card.classList.remove("session-card-dragging");

    if (currentIndex !== dragIndex && windowTabSet) {
      const names = cards.map(c => c.title);
      const [moved] = names.splice(dragIndex, 1);
      names.splice(currentIndex, 0, moved);
      windowTabSet.reorderTabs(names);
    }

    drag = null;
  }

  // ── Render ──────────────────────────────────────────────────────────

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
    const orderedSessions = orderByTabs(state.sessions);

    for (const s of orderedSessions) {
      const isCurrent = s.name === state.currentSession;

      const card = document.createElement("div");
      card.className = `session-card${isCurrent ? " active" : ""}${s.external ? " external" : ""}`;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-label", `Session: ${s.name}${s.external ? " (external tmux session)" : ""}`);
      card.setAttribute("data-initial", s.name.charAt(0));
      card.title = s.name;

      // Touch drag-and-drop for reordering (mobile sidebar)
      card.addEventListener("touchstart", (e) => {
        onCardTouchStart(e, card, s.name, container);
      }, { passive: true });

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

      // Drag handle indicator
      const handle = document.createElement("div");
      handle.className = "session-card-drag-handle";
      handle.innerHTML = '<i class="ph ph-dots-six"></i>';
      card.appendChild(handle);

      // Claude-presence badge — the server's pane monitor flips
      // meta.claude.running when tmux reports `claude` as the pane's
      // foreground command, so this lights up on every card whose tile
      // has Claude actively running.
      if (s.meta?.claude?.running) {
        const badge = document.createElement("div");
        badge.className = "session-card-claude-badge";
        badge.setAttribute("aria-label", "Claude session running");
        badge.innerHTML = '<i class="ph ph-sparkle"></i>';
        card.appendChild(badge);
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
          // List render has s.id in scope — rename via the stable id
          await api.put(`/sessions/by-id/${encodeURIComponent(s.id)}`, { name: newName });
          invalidateSessionIdCache(originalName);
          invalidateSessionIdCache(newName);
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
        const idx = orderedSessions.findIndex(x => x.name === removedName);
        const remaining = orderedSessions.filter(x => x.name !== removedName);
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
          await api.delete(`/sessions/by-id/${encodeURIComponent(s.id)}?action=detach`);
          invalidateSessionIdCache(s.name);
          if (windowTabSet) windowTabSet.removeTab(s.name);
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
          await api.delete(`/sessions/by-id/${encodeURIComponent(s.id)}`);
          invalidateSessionIdCache(s.name);
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
