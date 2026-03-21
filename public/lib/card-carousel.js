/**
 * Card Carousel (iPad/tablet only)
 *
 * Horizontal strip of terminal "cards". Each card is a live xterm.js terminal
 * at full available height. Single card = full width. Multiple cards share
 * width proportionally with horizontal scroll if they overflow.
 *
 * Each card has a subtle editable title (session name) centered at the top.
 * Cards can be reordered by dragging, resized by dragging edges, and
 * dismissed (detaches tmux session, doesn't kill it).
 */

const STORAGE_KEY = "katulong-carousel";

export function createCardCarousel({
  container,
  terminalPool,
  sendResize,
  onFocusChange,
  onCardDismissed,
  onAddClick,
}) {
  let active = false;
  let cards = [];           // ordered session names
  let focusedSession = null;
  const cardEls = new Map(); // sessionName -> { wrapper, titleInput }

  // ── Persistence ──────────────────────────────────────────────────────

  function save() {
    try {
      if (active && cards.length > 0) {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          cards: [...cards],
          focused: focusedSession,
        }));
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* sessionStorage unavailable */ }
  }

  function restore() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (state.cards?.length > 0) {
        return { sessions: state.cards, focused: state.focused };
      }
    } catch { /* ignore */ }
    return null;
  }

  // ── DOM helpers ──────────────────────────────────────────────────────

  function createCardWrapper(sessionName) {
    const wrapper = document.createElement("div");
    wrapper.className = "carousel-card";
    wrapper.dataset.session = sessionName;

    // Title bar
    const titleBar = document.createElement("div");
    titleBar.className = "card-title";

    const titleInput = document.createElement("input");
    titleInput.className = "card-title-input";
    titleInput.value = sessionName;
    titleInput.setAttribute("autocorrect", "off");
    titleInput.setAttribute("autocapitalize", "off");
    titleInput.setAttribute("spellcheck", "false");
    titleInput.readOnly = true;

    // Tap to edit
    titleInput.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      titleInput.readOnly = false;
      titleInput.select();
    });
    titleInput.addEventListener("blur", () => { titleInput.readOnly = true; });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      if (e.key === "Escape") { titleInput.value = sessionName; titleInput.blur(); }
      e.stopPropagation();
    });

    titleBar.appendChild(titleInput);

    // Dismiss button
    const dismissBtn = document.createElement("button");
    dismissBtn.className = "card-dismiss";
    dismissBtn.setAttribute("aria-label", `Close ${sessionName}`);
    dismissBtn.innerHTML = '<i class="ph ph-x"></i>';
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCard(sessionName);
    });
    titleBar.appendChild(dismissBtn);

    wrapper.appendChild(titleBar);

    // Focus on tap
    wrapper.addEventListener("pointerdown", () => {
      if (active && focusedSession !== sessionName) {
        focusCard(sessionName);
      }
    });

    return { wrapper, titleInput };
  }

  function createResizeHandle(leftSession, rightSession) {
    const handle = document.createElement("div");
    handle.className = "carousel-handle";
    handle.setAttribute("aria-label", "Resize");
    // Touch/mouse resize could be added here later
    return handle;
  }

  function createAddButton() {
    const btn = document.createElement("button");
    btn.className = "carousel-add";
    btn.setAttribute("aria-label", "Add session");
    btn.innerHTML = '<i class="ph ph-plus-circle"></i>';
    btn.addEventListener("click", () => { if (onAddClick) onAddClick(); });
    return btn;
  }

  // ── Layout ───────────────────────────────────────────────────────────

  function buildLayout() {
    // Clear container
    container.innerHTML = "";
    cardEls.clear();

    if (!active || cards.length === 0) return;

    container.dataset.carousel = "true";

    for (let i = 0; i < cards.length; i++) {
      const session = cards[i];
      const entry = terminalPool.getOrCreate(session);
      const { wrapper, titleInput } = createCardWrapper(session);

      // Move the terminal pane into the card wrapper
      wrapper.appendChild(entry.container);

      // Mark focused
      if (session === focusedSession) {
        wrapper.classList.add("focused");
      }

      cardEls.set(session, { wrapper, titleInput });
      container.appendChild(wrapper);

      // Resize handle between cards (not after the last one)
      if (i < cards.length - 1) {
        container.appendChild(createResizeHandle(session, cards[i + 1]));
      }
    }

    // Add button at the end
    container.appendChild(createAddButton());

    // Fit terminals after layout
    fitAll();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  function activate(sessions, focused) {
    active = true;
    cards = [...sessions];
    focusedSession = focused || sessions[0] || null;

    // Ensure all terminals exist and are protected
    for (const session of cards) {
      terminalPool.getOrCreate(session);
      terminalPool.protect(session);
    }

    buildLayout();
    save();
  }

  function deactivate() {
    if (!active) return;

    // Unprotect and move terminals back to container
    for (const session of cards) {
      terminalPool.unprotect(session);
    }

    // Move all terminal panes back to container root
    terminalPool.forEach((_name, entry) => {
      if (entry.container.parentElement !== container) {
        container.appendChild(entry.container);
      }
    });

    // Clean up carousel DOM
    delete container.dataset.carousel;
    container.innerHTML = "";
    cardEls.clear();

    active = false;
    cards = [];
    focusedSession = null;

    save();
  }

  // ── Card management ──────────────────────────────────────────────────

  function addCard(sessionName) {
    if (!active) return;
    if (cards.includes(sessionName)) return;

    cards.push(sessionName);
    terminalPool.getOrCreate(sessionName);
    terminalPool.protect(sessionName);

    buildLayout();
    save();
  }

  function removeCard(sessionName) {
    if (!active) return;
    const idx = cards.indexOf(sessionName);
    if (idx === -1) return;

    cards.splice(idx, 1);
    terminalPool.unprotect(sessionName);

    // Move terminal back to container root before removing wrapper
    const entry = terminalPool.get(sessionName);
    if (entry) {
      container.appendChild(entry.container);
    }

    if (onCardDismissed) onCardDismissed(sessionName);

    // Shift focus if the removed card was focused
    if (focusedSession === sessionName) {
      if (cards.length > 0) {
        focusedSession = cards[Math.min(idx, cards.length - 1)];
        if (onFocusChange) onFocusChange(focusedSession);
      } else {
        focusedSession = null;
        deactivate();
        return;
      }
    }

    buildLayout();
    save();
  }

  function focusCard(sessionName) {
    if (!active) return;
    if (!cards.includes(sessionName)) return;
    if (focusedSession === sessionName) return;

    focusedSession = sessionName;

    // Update focused class
    for (const [name, { wrapper }] of cardEls) {
      wrapper.classList.toggle("focused", name === sessionName);
    }

    // Focus the terminal
    const entry = terminalPool.get(sessionName);
    if (entry?.term?.focus) entry.term.focus();

    if (onFocusChange) onFocusChange(sessionName);
    save();
  }

  function renameCard(oldName, newName) {
    const idx = cards.indexOf(oldName);
    if (idx === -1) return;

    cards[idx] = newName;
    if (focusedSession === oldName) focusedSession = newName;

    // Update the title input
    const el = cardEls.get(oldName);
    if (el) {
      el.titleInput.value = newName;
      el.wrapper.dataset.session = newName;
      cardEls.delete(oldName);
      cardEls.set(newName, el);
    }

    save();
  }

  // ── Fit ──────────────────────────────────────────────────────────────

  function fitAll() {
    if (!active) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const session of cards) {
          const entry = terminalPool.get(session);
          if (!entry) continue;
          entry.fit.fit();
          if (entry.term.refresh) entry.term.refresh(0, entry.term.rows - 1);
          if (sendResize) sendResize(session, entry.term.cols, entry.term.rows);
        }
      });
    });
  }

  // ── Resize listener ──────────────────────────────────────────────────

  window.addEventListener("resize", () => {
    if (active) fitAll();
  });

  return {
    isActive: () => active,
    getCards: () => [...cards],
    getFocusedCard: () => focusedSession,
    activate,
    deactivate,
    addCard,
    removeCard,
    focusCard,
    renameCard,
    fitAll,
    save,
    restore,
    buildLayout,
  };
}
