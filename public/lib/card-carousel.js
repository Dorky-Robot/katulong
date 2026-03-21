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

    let startX = 0;
    let startWidthLeft = 0;
    let startWidthRight = 0;
    let leftCard = null;
    let rightCard = null;

    function onStart(cx) {
      leftCard = cardEls.get(leftSession)?.wrapper;
      rightCard = cardEls.get(rightSession)?.wrapper;
      if (!leftCard || !rightCard) return false;
      startX = cx;
      startWidthLeft = leftCard.getBoundingClientRect().width;
      startWidthRight = rightCard.getBoundingClientRect().width;
      return true;
    }

    function onMove(cx) {
      if (!leftCard || !rightCard) return;
      const dx = cx - startX;
      const newLeft = Math.max(200, startWidthLeft + dx);
      const newRight = Math.max(200, startWidthRight - dx);
      leftCard.style.flex = `0 0 ${newLeft}px`;
      rightCard.style.flex = `0 0 ${newRight}px`;
    }

    function onEnd() {
      leftCard = null;
      rightCard = null;
      // Refit terminals after resize
      fitAll();
      save();
    }

    // Touch
    handle.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      if (!onStart(e.touches[0].clientX)) return;
      const move = (te) => { te.preventDefault(); onMove(te.touches[0].clientX); };
      const end = () => { document.removeEventListener("touchmove", move); document.removeEventListener("touchend", end); onEnd(); };
      document.addEventListener("touchmove", move, { passive: false });
      document.addEventListener("touchend", end);
    }, { passive: false });

    // Mouse
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (!onStart(e.clientX)) return;
      const move = (me) => { me.preventDefault(); onMove(me.clientX); };
      const end = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", end); onEnd(); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
    });

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
    const entry = terminalPool.getOrCreate(sessionName);
    terminalPool.protect(sessionName);

    // Create the card wrapper and insert it before the + button
    const { wrapper, titleInput } = createCardWrapper(sessionName);
    wrapper.appendChild(entry.container);
    cardEls.set(sessionName, { wrapper, titleInput });

    // Insert a resize handle before the new card (if there are other cards)
    const addBtn = container.querySelector(".carousel-add");
    if (cards.length > 1) {
      const prevSession = cards[cards.length - 2];
      container.insertBefore(createResizeHandle(prevSession, sessionName), addBtn);
    }
    container.insertBefore(wrapper, addBtn);

    // Animate: start collapsed, then grow to natural size
    wrapper.style.flex = "0 0 0px";
    wrapper.style.opacity = "0";
    wrapper.style.transform = "scale(0.95)";
    wrapper.offsetHeight; // force reflow
    requestAnimationFrame(() => {
      wrapper.style.flex = "";
      wrapper.style.opacity = "";
      wrapper.style.transform = "";
      wrapper.scrollIntoView({ behavior: "smooth", inline: "center" });
    });

    fitAll();
    save();
  }

  function removeCard(sessionName) {
    if (!active) return;
    const idx = cards.indexOf(sessionName);
    if (idx === -1) return;

    const el = cardEls.get(sessionName);

    const doRemove = () => {
      // Remove the card wrapper and its preceding resize handle from DOM
      if (el?.wrapper?.parentElement) {
        // Find and remove the adjacent resize handle
        const prev = el.wrapper.previousElementSibling;
        const next = el.wrapper.nextElementSibling;
        if (prev?.classList?.contains("carousel-handle")) prev.remove();
        else if (next?.classList?.contains("carousel-handle")) next.remove();
        el.wrapper.remove();
      }
      cardEls.delete(sessionName);
      cards.splice(cards.indexOf(sessionName), 1);
      terminalPool.unprotect(sessionName);

      // Move terminal pane back to container root (hidden by default CSS)
      const entry = terminalPool.get(sessionName);
      if (entry) {
        entry.container.style.display = "none";
        container.appendChild(entry.container);
      }

      if (onCardDismissed) onCardDismissed(sessionName);

      // Shift focus
      if (focusedSession === sessionName) {
        if (cards.length > 0) {
          focusedSession = cards[Math.min(idx, cards.length - 1)];
          if (onFocusChange) onFocusChange(focusedSession);
          // Update focused class
          for (const [name, { wrapper }] of cardEls) {
            wrapper.classList.toggle("focused", name === focusedSession);
          }
        } else {
          focusedSession = null;
          deactivate();
          return;
        }
      }

      fitAll();
      save();
    };

    // Animate out: shrink + fade, then remove
    if (el?.wrapper?.style) {
      let done = false;
      const finish = () => { if (!done) { done = true; doRemove(); } };
      el.wrapper.style.transition = "flex 0.3s ease, opacity 0.2s ease, transform 0.3s ease, min-width 0.3s ease";
      el.wrapper.style.flex = "0 0 0px";
      el.wrapper.style.minWidth = "0";
      el.wrapper.style.opacity = "0";
      el.wrapper.style.transform = "scale(0.92)";
      el.wrapper.style.overflow = "hidden";
      el.wrapper.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 400);
    } else {
      doRemove();
    }
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
